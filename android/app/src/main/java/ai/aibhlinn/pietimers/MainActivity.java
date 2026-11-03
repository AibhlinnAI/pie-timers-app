package ai.aibhlinn.pietimers;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONObject;

import java.io.OutputStream;

/**
 * The Pie Timers Android app from release 4: the website in a WebView.
 *
 * Releases 1 to 3 were a Trusted Web Activity built by PWABuilder, which
 * opened the site in Chrome. Everything a person sees is still the website;
 * this class only hosts it, and adds what a plain WebView lacks: a splash
 * screen, an offline screen with Retry, Back that walks the page's history,
 * a file picker for Import settings and a save dialog for Export settings.
 */
public class MainActivity extends ComponentActivity {

    private static final String HOST = "pietimers.aibhlinn.ai";
    private static final String START_URL = "https://" + HOST + "/index.html";

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

    private WebView web;
    private View offline;
    private boolean ready;

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
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root), (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                    | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        web = findViewById(R.id.web);
        offline = findViewById(R.id.offline);
        findViewById(R.id.retry).setOnClickListener(v -> retry());

        chooser = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (pendingChooser == null) return;
            pendingChooser.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData()));
            pendingChooser = null;
        });
        saver = registerForActivityResult(
                new ActivityResultContracts.CreateDocument("application/json"), this::writePendingSave);

        setUpWebView();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web != null && offline.getVisibility() != View.VISIBLE && web.canGoBack()) {
                    web.goBack();
                    return;
                }
                /* Nothing to go back to: Back does what it does for any app. */
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });

        if (savedInstanceState != null && web.restoreState(savedInstanceState) != null) return;
        web.loadUrl(urlFor(getIntent()));
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setUpWebView() {
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
    private static String urlFor(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (Intent.ACTION_VIEW.equals(intent == null ? null : intent.getAction()) && isOurs(data)) {
            return data.toString();
        }
        return START_URL;
    }

    private static boolean isOurs(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && HOST.equalsIgnoreCase(uri.getHost());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (web != null && Intent.ACTION_VIEW.equals(intent.getAction()) && isOurs(intent.getData())) {
            web.loadUrl(intent.getData().toString());
        }
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
    }

    private void retry() {
        offline.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        String url = web.getUrl();
        if (url == null || !isOurs(Uri.parse(url))) web.loadUrl(START_URL);
        else web.reload();
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame() || isOurs(request.getUrl())) return false;
            openOutside(request.getUrl());
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            ready = true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline();
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

    private void writePendingSave(Uri uri) {
        byte[] bytes = pendingSave;
        pendingSave = null;
        if (uri == null || bytes == null) return;
        try (OutputStream out = getContentResolver().openOutputStream(uri)) {
            if (out == null) throw new java.io.IOException("no stream");
            out.write(bytes);
        } catch (Exception e) {
            Toast.makeText(this, R.string.save_failed, Toast.LENGTH_LONG).show();
        }
    }

    /* onPause() does not stop the page's JavaScript, so alerts due while
       the app is in the background still run until Android freezes it. */
    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
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
