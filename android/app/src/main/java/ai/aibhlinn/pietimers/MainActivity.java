package ai.aibhlinn.pietimers;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import org.json.JSONObject;

import java.io.OutputStream;

/**
 * The Pie Timers Android app from release 4: the website in a WebView.
 *
 * Releases 1 to 3 were a Trusted Web Activity built by PWABuilder, which
 * opened the site in Chrome. Everything a person sees is still the website;
 * this class only hosts it, and adds what a plain WebView lacks: a splash
 * screen, an offline screen with Retry, Back that walks the page's history,
 * full screen for the dashboard, a file picker for Import settings and a
 * save dialog for Export settings.
 */
public class MainActivity extends ComponentActivity {

    private static final String HOST = "pietimers.aibhlinn.ai";
    private static final String SITE = "https://" + HOST + "/";
    private static final String START_URL = SITE + "index.html";

    /* The site hides prices, checkout and Google sign-in when it sees this,
       and stops offering system notifications (WEBVIEW_UA in app/app.js, and
       the copies its comment lists). Keep the leading space and the exact
       spelling: changing either puts prices back inside the Play app. */
    private static final String UA_TOKEN = " PieTimersAndroid/" + BuildConfig.VERSION_CODE;

    /* The splash stays until the first page has drawn, but never longer
       than this, so a slow network still reaches the app. */
    private static final long SPLASH_MAX_MS = 4000;

    /* Export settings is the only file the site offers to save. */
    private static final String EXPORT_NAME = "countdown-timers-settings.json";
    private static final String STATE_PENDING_SAVE = "pendingSave";
    private static final String PREFS = "app";
    private static final String PREF_LAUNCHED = "launched";

    private FrameLayout root;
    private WebView web;
    private View offline;
    private boolean ready;
    /* Whether the main frame of the load in progress failed. */
    private boolean mainFrameFailed;

    private View fullScreenView;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private OnBackPressedCallback back;

    private ValueCallback<Uri[]> pendingChooser;
    private ActivityResultLauncher<Intent> chooser;
    private byte[] pendingSave;
    private ActivityResultLauncher<String> saver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        /* Light icons on the site's dark purple, as the TWA had. */
        EdgeToEdge.enable(this,
                SystemBarStyle.dark(Color.TRANSPARENT),
                SystemBarStyle.dark(Color.TRANSPARENT));
        setContentView(R.layout.activity_main);

        splash.setKeepOnScreenCondition(() -> !ready);
        new Handler(Looper.getMainLooper()).postDelayed(() -> ready = true, SPLASH_MAX_MS);

        /* From Android 15 an app draws behind the system bars, and the site
           has no safe-area padding of its own, so the bars and the keyboard
           are kept off the page here. */
        root = findViewById(R.id.root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                    | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        web = findViewById(R.id.web);
        offline = findViewById(R.id.offline);
        findViewById(R.id.retry).setOnClickListener(v -> retry());

        if (savedInstanceState != null) pendingSave = savedInstanceState.getByteArray(STATE_PENDING_SAVE);
        chooser = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (pendingChooser == null) return;
            pendingChooser.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData()));
            pendingChooser = null;
        });
        saver = registerForActivityResult(
                new ActivityResultContracts.CreateDocument("application/json"), this::writePendingSave);

        setUpWebView();

        /* Enabled only while there is something in the app to go back to,
           so Android's predictive Back can show its back-to-home preview
           the rest of the time. */
        back = new OnBackPressedCallback(false) {
            @Override
            public void handleOnBackPressed() {
                if (fullScreenView != null) {
                    if (fullScreenCallback != null) fullScreenCallback.onCustomViewHidden();
                } else if (web != null && web.canGoBack()) {
                    web.goBack();
                }
                updateBack();
            }
        };
        getOnBackPressedDispatcher().addCallback(this, back);

        if (savedInstanceState != null && web.restoreState(savedInstanceState) != null) return;
        web.loadUrl(urlFor(getIntent()));
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setUpWebView() {
        /* No white flash before the first paint: the splash's own colour. */
        web.setBackgroundColor(ContextCompat.getColor(this, R.color.app_background));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        /* The alert chime plays without a tap, as it does in a browser tab
           the person has already used. */
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + UA_TOKEN);

        /* The sign-in bot check (Cloudflare Turnstile) runs in a frame from
           another site and needs its cookies. */
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        web.addJavascriptInterface(new FileBridge(), "PieTimersAndroidFiles");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, userAgent, disposition, mimeType, length) -> {
            if (url.startsWith("blob:")) readBlob(url);
            else openOutside(Uri.parse(url));
        });
    }

    /* A link to the site opens that page; anything else opens the app. */
    private String urlFor(Intent intent) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            String link = siteUrl(intent.getData());
            if (link != null) return link;
        }
        return startUrl();
    }

    /* The link exactly as it will be loaded, if it is on the site. Another
       app can hand over a Uri whose getHost() and toString() disagree (an
       authority such as "evil.example/@pietimers.aibhlinn.ai"), so the
       string itself is checked: with the trailing slash in the prefix,
       nothing after it can change the host. */
    private static String siteUrl(Uri uri) {
        if (uri == null) return null;
        String s = uri.toString();
        return s.regionMatches(true, 0, SITE, 0, SITE.length()) ? s : null;
    }

    /* For URLs Chromium has already parsed (navigations, the page showing),
       where the host and the string cannot disagree. */
    private static boolean isOurs(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && HOST.equalsIgnoreCase(uri.getHost());
    }

    /* Two launches that are not a person's first open, so the site is told
       not to count them (#count=off; app/visits.js marks the visit counted
       and sends nothing): Google's pre-launch test devices, which run every
       upload on freshly wiped phones, and a tester's first launch after
       updating from the TWA, whose first open was counted in Chrome. A new
       install still counts.

       The second also gets moved=1. The TWA kept the person's week in
       Chrome's storage, which this app cannot read, so it opens empty; the
       site then shows, once, how to bring the week across (app/app.js,
       movedNotice). */
    private String startUrl() {
        boolean testLab = "true".equals(
                Settings.System.getString(getContentResolver(), "firebase.test.lab"));

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean firstLaunch = !prefs.getBoolean(PREF_LAUNCHED, false);
        if (firstLaunch) prefs.edit().putBoolean(PREF_LAUNCHED, true).apply();

        boolean updated = false;
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            updated = info.lastUpdateTime > info.firstInstallTime;
        } catch (Exception e) {
            // Unknown: count it, as a new install would be.
        }
        if (firstLaunch && updated) return START_URL + "#count=off&moved=1";
        return testLab ? START_URL + "#count=off" : START_URL;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (web == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        String link = siteUrl(intent.getData());
        if (link != null) web.loadUrl(link);
    }

    /* Pages on the site stay in the app. Every other link goes to whatever
       the phone opens it with, and only these schemes are handed on:
       intent:, file:, javascript: and the rest never leave the page. */
    private void openOutside(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        Intent intent;
        switch (scheme) {
            case "http":
            case "https":
                intent = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE);
                break;
            case "mailto":
                intent = new Intent(Intent.ACTION_SENDTO, uri);
                break;
            case "tel":
                intent = new Intent(Intent.ACTION_DIAL, uri);
                break;
            default:
                return;
        }
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_LONG).show();
        }
    }

    private void showOffline() {
        ready = true;
        offline.setVisibility(View.VISIBLE);
        web.setVisibility(View.INVISIBLE);
        updateBack();
    }

    private void hideOffline() {
        offline.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        updateBack();
    }

    /* Chromium's error page has replaced the failed URL in history, so
       reload() would only reload that page: load the address again. */
    private void retry() {
        hideOffline();
        String url = web.getUrl();
        web.loadUrl(url != null && isOurs(Uri.parse(url)) ? url : START_URL);
    }

    private void updateBack() {
        if (back == null) return;
        boolean offlineShowing = offline != null && offline.getVisibility() == View.VISIBLE;
        back.setEnabled(fullScreenView != null
                || (!offlineShowing && web != null && web.canGoBack()));
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame() || isOurs(request.getUrl())) return false;
            openOutside(request.getUrl());
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            mainFrameFailed = false;
        }

        /* A load that got through takes the offline screen down, however it
           was started: Try again, a link from another app, or the page. */
        @Override
        public void onPageFinished(WebView view, String url) {
            ready = true;
            if (!mainFrameFailed && offline.getVisibility() == View.VISIBLE) hideOffline();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            mainFrameFailed = true;
            showOffline();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            updateBack();
        }

        /* The page's renderer was killed (low memory) or crashed. Start the
           screen again rather than let Android close the app. */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
            view.destroy();
            if (view == web) web = null;
            recreate();
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        /* Import settings. Any file type: Android often labels a downloaded
           .json as a plain binary file, and a JSON-only picker would grey it
           out. The page checks what it reads. */
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (pendingChooser != null) pendingChooser.onReceiveValue(null);
            pendingChooser = callback;
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*");
            try {
                chooser.launch(pick);
            } catch (ActivityNotFoundException e) {
                pendingChooser = null;
                callback.onReceiveValue(null);
                Toast.makeText(MainActivity.this, R.string.no_app_for_files, Toast.LENGTH_LONG).show();
            }
            return true;
        }

        /* The dashboard's Full screen button asks the page for full screen,
           which a WebView hands to the app as a view to show over everything.
           Without this the button does nothing. */
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullScreenView != null) {
                callback.onCustomViewHidden();
                return;
            }
            fullScreenView = view;
            fullScreenCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            WindowInsetsControllerCompat bars =
                    WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            bars.hide(WindowInsetsCompat.Type.systemBars());
            updateBack();
        }

        @Override
        public void onHideCustomView() {
            if (fullScreenView == null) return;
            root.removeView(fullScreenView);
            fullScreenView = null;
            fullScreenCallback = null;
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView())
                    .show(WindowInsetsCompat.Type.systemBars());
            updateBack();
        }
    }

    /* Export settings hands the browser a blob: link and revokes it a
       second later (app.js). A WebView cannot download one, so the page is
       asked to read it and pass the bytes to FileBridge while it lasts. */
    private void readBlob(String url) {
        String js = "(function(u){fetch(u).then(function(r){return r.blob();}).then(function(b){"
                + "var f=new FileReader();f.onloadend=function(){var s=String(f.result);"
                + "PieTimersAndroidFiles.save(s.slice(s.indexOf(',')+1));};f.readAsDataURL(b);});})("
                + JSONObject.quote(url) + ");";
        if (web != null) web.evaluateJavascript(js, null);
    }

    /* Called from the page, on a WebView thread. Nothing is written until
       the person picks where in Android's own save dialog, and only while
       the site itself is the page showing. */
    private final class FileBridge {
        @JavascriptInterface
        public void save(String base64) {
            final byte[] bytes;
            try {
                bytes = Base64.decode(base64, Base64.DEFAULT);
            } catch (IllegalArgumentException e) {
                return;
            }
            runOnUiThread(() -> {
                if (web == null || !isOurs(Uri.parse(String.valueOf(web.getUrl())))) return;
                pendingSave = bytes;
                try {
                    saver.launch(EXPORT_NAME);
                } catch (ActivityNotFoundException e) {
                    pendingSave = null;
                    Toast.makeText(MainActivity.this, R.string.no_app_for_files, Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    /* "wt": replacing an earlier, longer export must not leave its tail
       behind, which would make the JSON unreadable. */
    private void writePendingSave(Uri uri) {
        byte[] bytes = pendingSave;
        pendingSave = null;
        if (uri == null || bytes == null) return;
        try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new java.io.IOException("no stream");
            out.write(bytes);
        } catch (Exception e) {
            Toast.makeText(this, R.string.save_failed, Toast.LENGTH_LONG).show();
        }
    }

    /* Paused when the app is out of sight, not merely out of focus: in
       split screen on Android 7 to 9 an unfocused app is paused but still
       showing, and its pies must keep moving. The page's JavaScript runs on
       either way, so alerts still fire until Android freezes the app. */
    @Override
    protected void onStart() {
        super.onStart();
        if (web != null) web.onResume();
    }

    @Override
    protected void onStop() {
        if (web != null) web.onPause();
        super.onStop();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
        /* The save dialog can outlive this activity (rotation, low memory),
           and the bytes must still be here when it answers. */
        if (pendingSave != null) outState.putByteArray(STATE_PENDING_SAVE, pendingSave);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
