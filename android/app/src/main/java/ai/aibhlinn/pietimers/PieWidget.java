package ai.aibhlinn.pietimers;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.net.Uri;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The home screen widget: up to three pies, the same three as the
 * Dashboard (the next break or lunch, the end of the day, the next
 * appointment), each with its name above and the time left below.
 *
 * It holds no timer maths. The page works out the days ahead and hands
 * them over through the bridge in MainActivity (widgetSnapshot() in
 * app/app.js has the format): for each pie, pieces saying "between these
 * two instants show this name, on a pie that starts full at s and runs
 * out at e". All this class does is find the piece for now and draw how
 * much of it is left. tools/widget-sim.js checks the page's half against
 * the Dashboard's own functions.
 *
 * Android draws a widget itself, from the views handed to it here, so it
 * only changes when this class sends new ones: once a minute while the
 * phone is awake, and whenever the page hands over a new week.
 *
 * Two names run along the top. Tapping "Pie Timers" turns the widget over
 * to a QR code for the app's Google Play page, and tapping "AibhlínnAI"
 * to one for aibhlinn.ai; tapping the same name again, or the code, turns
 * it back. A home screen keeps sideways swipes for moving between its own
 * pages, so a widget never sees one.
 */
public class PieWidget extends AppWidgetProvider {

    private static final String ACTION_TICK = "ai.aibhlinn.pietimers.widget.TICK";
    private static final String ACTION_FLIP = "ai.aibhlinn.pietimers.widget.FLIP";

    private static final String PREFS = "widget";
    private static final String PREF_SNAPSHOT = "snapshot";
    /* Per widget: which side it is showing. */
    private static final String PREF_SIDE = "side_";
    private static final String EXTRA_SIDE = "side";
    private static final int SIDE_PIES = 0;
    private static final int SIDE_QR_PIE = 1;
    private static final int SIDE_QR_AI = 2;
    /* What a build before the two names kept: true while its one QR code
       was showing. Only cleared now. */
    private static final String PREF_QR_OLD = "qr_";

    /* The page sends about three thousand characters for a busy week.
       Anything far beyond that did not come from the page. */
    private static final int MAX_SNAPSHOT = 200_000;
    private static final int MAX_LABEL = 40;

    /* A pie and its two lines need about this much width each. */
    private static final int SLOT_DP = 80;
    private static final int MIN_PIE_DP = 28;
    private static final int MAX_PIE_DP = 140;
    /* Everything in the widget that is not pie: padding, the name in the
       corner, and the two lines of text. */
    private static final int CHROME_DP = 72;
    /* Narrower than this and the two names along the top do not both
       fit, so only their icons are shown. */
    private static final int NAMES_DP = 200;
    /* A pie with less width than this gets smaller text, so one pie's
       time never runs into the next. */
    private static final int ROOMY_SLOT_DP = 100;

    private static final long MINUTE_MS = 60_000L;

    private static final int[] SLOT = {R.id.slot1, R.id.slot2, R.id.slot3};
    private static final int[] LABEL = {R.id.slot1_label, R.id.slot2_label, R.id.slot3_label};
    private static final int[] PIE = {R.id.slot1_pie, R.id.slot2_pie, R.id.slot3_pie};
    private static final int[] TIME = {R.id.slot1_time, R.id.slot2_time, R.id.slot3_time};
    private static final int[] FILL = {
            R.color.widget_pie_break, R.color.widget_pie_end, R.color.widget_pie_appointment};

    /* ─────────────────────── What the page hands over ─────────────────────── */

    /**
     * Keeps the week the page worked out and redraws every widget.
     * Called from the bridge in MainActivity, which has already checked
     * that the site is the page showing.
     *
     * @return false when it was not a week this class can read
     */
    static boolean store(Context context, String json) {
        if (json == null || json.length() > MAX_SNAPSHOT) return false;
        try {
            JSONObject snapshot = new JSONObject(json);
            if (snapshot.optInt("v") != 1 || snapshot.optJSONArray("slots") == null) return false;
        } catch (JSONException e) {
            return false;
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(PREF_SNAPSHOT, json).apply();
        updateAll(context);
        return true;
    }

    /* ─────────────────────── Android's calls ─────────────────────── */

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) draw(context, manager, id);
        /* Also where the alarm is set again after a restart or an app
           update, both of which clear it: Android calls this then. */
        schedule(context);
    }

    /* Resized. */
    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id,
                                          Bundle options) {
        draw(context, manager, id);
    }

    @Override
    public void onDeleted(Context context, int[] ids) {
        SharedPreferences.Editor edit =
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        for (int id : ids) edit.remove(PREF_SIDE + id).remove(PREF_QR_OLD + id);
        edit.apply();
    }

    /* The last widget has gone: nothing left to keep up to date. */
    @Override
    public void onDisabled(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms != null) alarms.cancel(tick(context));
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (ACTION_TICK.equals(action)) {
            updateAll(context);
        } else if (ACTION_FLIP.equals(action)) {
            int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,
                    AppWidgetManager.INVALID_APPWIDGET_ID);
            if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return;
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            /* Tapping the name of the side already showing turns back. */
            int asked = intent.getIntExtra(EXTRA_SIDE, SIDE_PIES);
            int side = asked == prefs.getInt(PREF_SIDE + id, SIDE_PIES) ? SIDE_PIES : asked;
            prefs.edit().putInt(PREF_SIDE + id, side).remove(PREF_QR_OLD + id).apply();
            draw(context, AppWidgetManager.getInstance(context), id);
        } else {
            super.onReceive(context, intent);
        }
    }

    private static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, PieWidget.class));
        if (ids.length == 0) return;
        for (int id : ids) draw(context, manager, id);
    }

    /* ─────────────────────── The once-a-minute alarm ─────────────────────── */

    private static PendingIntent tick(Context context) {
        Intent intent = new Intent(context, PieWidget.class).setAction(ACTION_TICK);
        return PendingIntent.getBroadcast(context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /* A minute is the finest a pie of several hours can show anyway.
       RTC, not RTC_WAKEUP: the alarm never wakes a sleeping phone, and
       the one that came due while it slept arrives when it wakes, so the
       widget is right again by the time anyone can see it. Android may
       run it a little late to save battery; it needs no permission. */
    private static void schedule(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (alarms == null) return;
        long now = System.currentTimeMillis();
        long nextMinute = now - now % MINUTE_MS + MINUTE_MS;
        alarms.setRepeating(AlarmManager.RTC, nextMinute, MINUTE_MS, tick(context));
    }

    /* ─────────────────────── Drawing one widget ─────────────────────── */

    private static void draw(Context context, AppWidgetManager manager, int id) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int side = prefs.getInt(PREF_SIDE + id, SIDE_PIES);
        RemoteViews views = side == SIDE_PIES
                ? pieSide(context, manager, id, prefs.getString(PREF_SNAPSHOT, null))
                : qrSide(context, id, side == SIDE_QR_AI);
        int names = size(context, manager, id)[0] < NAMES_DP ? View.GONE : View.VISIBLE;
        views.setViewVisibility(R.id.widget_brand_pie_text, names);
        views.setViewVisibility(R.id.widget_brand_ai_text, names);
        views.setOnClickPendingIntent(R.id.widget_brand_pie, flip(context, id, SIDE_QR_PIE));
        views.setOnClickPendingIntent(R.id.widget_brand_ai, flip(context, id, SIDE_QR_AI));
        manager.updateAppWidget(id, views);
    }

    private static RemoteViews qrSide(Context context, int id, boolean ai) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_qr);
        views.setOnClickPendingIntent(R.id.widget_root, flip(context, id, SIDE_PIES));
        views.setImageViewResource(R.id.widget_qr,
                ai ? R.drawable.widget_qr_ai : R.drawable.widget_qr_pie);
        views.setContentDescription(R.id.widget_qr, context.getString(
                ai ? R.string.widget_qr_ai_about : R.string.widget_qr_pie_about));
        views.setTextViewText(R.id.widget_qr_caption, context.getString(
                ai ? R.string.widget_qr_ai_caption : R.string.widget_qr_pie_caption));
        return views;
    }

    private static RemoteViews pieSide(Context context, AppWidgetManager manager, int id,
                                       String json) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_pies);
        views.setOnClickPendingIntent(R.id.widget_root, openApp(context));

        long now = System.currentTimeMillis();
        JSONObject snapshot = read(json);
        /* No week yet (the app has not been opened since the widget was
           added), or the week has run out (not opened for seven days).
           Either way the app has to be opened once, and tapping does it. */
        if (snapshot == null || now >= snapshot.optLong("until")) {
            views.setViewVisibility(R.id.widget_pies, View.GONE);
            views.setViewVisibility(R.id.widget_note, View.VISIBLE);
            return views;
        }
        views.setViewVisibility(R.id.widget_pies, View.VISIBLE);
        views.setViewVisibility(R.id.widget_note, View.GONE);

        int[] size = size(context, manager, id);
        int width = size[0];
        int height = size[1];

        int room = Math.max(1, Math.min(3, width / SLOT_DP));
        int pieDp = Math.max(MIN_PIE_DP,
                Math.min(MAX_PIE_DP, Math.min(width / room - 12, height - CHROME_DP)));
        int piePx = Math.round(pieDp * context.getResources().getDisplayMetrics().density);

        Slot[] slots = new Slot[3];
        JSONArray all = snapshot.optJSONArray("slots");
        JSONArray names = snapshot.optJSONArray("names");
        long urgentMs = Math.max(0, snapshot.optLong("urgentMin")) * MINUTE_MS;
        for (int i = 0; i < 3; i++) {
            slots[i] = Slot.at(all == null ? null : all.optJSONArray(i), now,
                    names == null ? "" : names.optString(i, ""), urgentMs);
        }

        boolean[] shown = choose(slots, room);
        boolean roomy = width / room >= ROOMY_SLOT_DP;
        for (int i = 0; i < 3; i++) {
            views.setViewVisibility(SLOT[i], shown[i] ? View.VISIBLE : View.GONE);
            if (!shown[i]) continue;
            Slot slot = slots[i];
            String time = slot.time(context);
            views.setTextViewText(LABEL[i], slot.label);
            views.setTextViewText(TIME[i], time);
            views.setTextViewTextSize(LABEL[i], TypedValue.COMPLEX_UNIT_SP, roomy ? 12 : 11);
            views.setTextViewTextSize(TIME[i], TypedValue.COMPLEX_UNIT_SP, roomy ? 14 : 12);
            views.setTextColor(TIME[i], ContextCompat.getColor(context,
                    slot.running() ? R.color.widget_text : R.color.widget_off));
            views.setImageViewBitmap(PIE[i], pie(context, piePx, slot, i));
            views.setContentDescription(SLOT[i], slot.running()
                    ? context.getString(R.string.widget_slot_spoken, slot.label, time)
                    : slot.label + ", " + time);
        }
        return views;
    }

    /* The width and height the home screen gives the widget, in dp. It
       reports a range; upright uses the narrow width with the tall
       height, and on its side the other pair. */
    private static int[] size(Context context, AppWidgetManager manager, int id) {
        Bundle options = manager.getAppWidgetOptions(id);
        boolean sideways = context.getResources().getConfiguration().orientation
                == Configuration.ORIENTATION_LANDSCAPE;
        int width = options.getInt(sideways
                ? AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH
                : AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH);
        int height = options.getInt(sideways
                ? AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
                : AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT);
        return new int[] {width <= 0 ? 250 : width, height <= 0 ? 110 : height};
    }

    /* Which pies a widget with room for fewer than three shows: the ones
       still counting down first, soonest first, then one that has been
       reached, then one with nothing on it. They keep their own places,
       left to right, so a pie never jumps sides when another runs out. */
    private static boolean[] choose(Slot[] slots, int room) {
        boolean[] shown = new boolean[3];
        for (int n = 0; n < room; n++) {
            int best = -1;
            for (int i = 0; i < 3; i++) {
                if (shown[i]) continue;
                if (best < 0 || slots[i].rank() < slots[best].rank()) best = i;
            }
            if (best >= 0) shown[best] = true;
        }
        return shown;
    }

    /* The pie's radius as a share of its plate's, as in the app's icon
       (app/icon.svg: pie 150, plate 184), so the plate shows as a rim. */
    private static final float PIE_ON_PLATE = 150f / 184f;

    /* A solid pie, never a ring: the filled area is the time left, as on
       the Dashboard (wedgePath() in app/app.js). The gap opens at twelve
       o'clock and grows clockwise, so what is left always ends at twelve.
       It sits on a plate with a rim, as the icon's pie does. */
    private static Bitmap pie(Context context, int size, Slot slot, int index) {
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        float edge = Math.max(1f, size / 48f);
        RectF plate = new RectF(edge, edge, size - edge, size - edge);
        float inset = plate.width() / 2f * (1f - PIE_ON_PLATE);
        RectF dial = new RectF(plate.left + inset, plate.top + inset,
                plate.right - inset, plate.bottom - inset);

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(ContextCompat.getColor(context,
                slot.seen ? R.color.widget_plate : R.color.widget_off_plate));
        canvas.drawOval(plate, paint);
        /* A plate with nothing on it today still has its outline, so the
           place reads as empty and not as missing. */
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(edge);
        paint.setColor(ContextCompat.getColor(context,
                slot.seen ? R.color.widget_plate_rim : R.color.widget_off_rim));
        canvas.drawOval(plate, paint);
        /* Reached: the pie is eaten, and a thin ring in its own colour
           stays to say which pie it was. */
        if (slot.seen && slot.fraction <= 0f) {
            paint.setColor(ContextCompat.getColor(context, FILL[index]));
            canvas.drawOval(dial, paint);
        }
        paint.setStyle(Paint.Style.FILL);

        if (slot.fraction > 0f) {
            boolean urgent = slot.urgent;
            int fill = !urgent ? FILL[index]
                    : index == 2 ? R.color.widget_urgent : R.color.widget_urgent_good;
            paint.setColor(ContextCompat.getColor(context, fill));
            if (slot.fraction >= 0.99999f) {
                canvas.drawOval(dial, paint);
            } else {
                float gone = 360f * (1f - slot.fraction);
                canvas.drawArc(dial, -90f + gone, 360f - gone, true, paint);
            }
            /* Crimson is hard to tell from the green plate, so the urgent
               appointment pie carries a light rim (app/styles.css). */
            if (urgent && index == 2) {
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(edge);
                paint.setColor(ContextCompat.getColor(context, R.color.widget_urgent_edge));
                canvas.drawOval(dial, paint);
            }
        }
        return bitmap;
    }

    /* ─────────────────────── One pie, now ─────────────────────── */

    private static final class Slot {
        String label = "";
        /* Whether there is a pie at all. */
        boolean seen;
        /* How much of the pie is left, 0 to 1. */
        float fraction;
        long leftMs;
        boolean urgent;

        boolean running() {
            return seen && leftMs > 0;
        }

        /* Lower is shown first when there is not room for all three. */
        long rank() {
            if (running()) return leftMs;
            return seen ? Long.MAX_VALUE - 1 : Long.MAX_VALUE;
        }

        /* "2d 3h", "2h 5m" or "23m", rounded up to the minute as the
           Dashboard's dial is, so a pie never reads 0m while it runs. */
        String time(Context context) {
            if (!seen) return context.getString(R.string.widget_idle);
            if (leftMs <= 0) return context.getString(R.string.widget_reached);
            long minutes = (leftMs + MINUTE_MS - 1) / MINUTE_MS;
            long days = minutes / 1440;
            long hours = minutes / 60 % 24;
            long mins = minutes % 60;
            if (days > 0) return days + "d " + hours + "h";
            if (hours > 0) return hours + "h " + mins + "m";
            return mins + "m";
        }

        /* The piece of this pie's week that covers `now`. Each piece is
           { l: name, a and b: shown from and until, s and e: the pie
           starts full and runs out, q: 1 if it never turns urgent }. */
        static Slot at(JSONArray pieces, long now, String idleName, long urgentMs) {
            Slot slot = new Slot();
            slot.label = clip(idleName);
            if (pieces == null) return slot;
            for (int i = 0; i < pieces.length(); i++) {
                JSONObject piece = pieces.optJSONObject(i);
                if (piece == null) continue;
                if (now < piece.optLong("a") || now >= piece.optLong("b")) continue;
                long starts = piece.optLong("s");
                long ends = piece.optLong("e");
                if (ends <= starts) continue;
                slot.seen = true;
                slot.label = clip(piece.optString("l", idleName));
                slot.leftMs = Math.max(0, ends - now);
                slot.fraction = Math.min(1f, (float) slot.leftMs / (float) (ends - starts));
                slot.urgent = piece.optInt("q") == 0 && urgentMs > 0
                        && slot.leftMs > 0 && slot.leftMs <= urgentMs;
                break;
            }
            return slot;
        }
    }

    private static JSONObject read(String json) {
        if (json == null) return null;
        try {
            return new JSONObject(json);
        } catch (JSONException e) {
            return null;
        }
    }

    private static String clip(String s) {
        if (s == null) return "";
        s = s.trim();
        return s.length() <= MAX_LABEL ? s : s.substring(0, MAX_LABEL - 1) + "…";
    }

    /* ─────────────────────── Taps ─────────────────────── */

    private static PendingIntent openApp(Context context) {
        Intent open = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /* One per widget and per side asked for: Android tells two of these
       apart by the address, never by the extras, so the address carries
       both and two widgets turn over separately. */
    private static PendingIntent flip(Context context, int id, int side) {
        Intent intent = new Intent(context, PieWidget.class)
                .setAction(ACTION_FLIP)
                .setData(Uri.parse("pietimers-widget://flip/" + id + "/" + side))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .putExtra(EXTRA_SIDE, side);
        return PendingIntent.getBroadcast(context, id, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
