package ai.aibhlinn.pietimers;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import java.util.Map;

/**
 * Shows a milestone alert as a phone notification.
 *
 * Two things ask for one. The page does while it is running (the bridge in
 * MainActivity), and Firebase Cloud Messaging does when the server sends
 * one (PushService), which is what reaches a closed app. Both can ask for
 * the same milestone, up to a minute apart, and both carry the same tag
 * (date|timer|milestone, tagFor() in app/app.js). A tag is shown once.
 */
final class Notifier {

    private static final String CHANNEL = "milestones";
    /* Tags already shown, each with when. */
    private static final String PREFS = "alerts_shown";
    private static final long REMEMBER_MS = 36L * 60 * 60 * 1000;

    private static final int MAX_TITLE = 80;
    private static final int MAX_BODY = 240;

    private Notifier() {}

    /** Whether Android will show this app's notifications at all. */
    static boolean allowed(Context context) {
        return NotificationManagerCompat.from(context).areNotificationsEnabled();
    }

    /* Made the first time it is needed, and harmless to repeat. Its name
       and description are what the person sees under Settings > Apps >
       Pie Timers > Notifications. Once it exists, its sound and importance
       are the person's to change, not the app's. */
    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL,
                context.getString(R.string.channel_milestones), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(context.getString(R.string.channel_milestones_about));
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    /**
     * Shows one alert, unless its tag has been shown already.
     *
     * @param quiet no sound or vibration: the app is on screen, where the
     *              page has its own toast and chime for the same alert.
     */
    static void show(Context context, String title, String body, String tag, boolean quiet) {
        if (title == null || title.trim().isEmpty()) return;
        if (!allowed(context)) return;
        if (tag == null || tag.isEmpty()) tag = "alert";
        if (!firstTime(context, tag)) return;

        ensureChannel(context);

        Intent open = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String text = clip(body, MAX_BODY);
        Notification notification = new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(ContextCompat.getColor(context, R.color.accent))
                .setContentTitle(clip(title, MAX_TITLE))
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setSilent(quiet)
                .build();

        try {
            /* The tag is the identity, so a milestone can only ever hold
               one place in the shade. */
            NotificationManagerCompat.from(context).notify(tag, 1, notification);
        } catch (SecurityException e) {
            // Permission taken away between the check and the call.
        }
    }

    /* True the first time a tag is seen, and it is then remembered. A
       milestone's tag has the date in it, so it is shown once, ever. A tag
       without a "|" is not a milestone (the Settings test button sends
       "test") and may repeat. */
    private static synchronized boolean firstTime(Context context, String tag) {
        if (tag.indexOf('|') < 0) return true;

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        boolean seen = prefs.contains(tag);

        SharedPreferences.Editor edit = prefs.edit();
        for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            Object when = entry.getValue();
            if (!(when instanceof Long) || now - (Long) when > REMEMBER_MS) edit.remove(entry.getKey());
        }
        if (!seen) edit.putLong(tag, now);
        edit.apply();
        return !seen;
    }

    private static String clip(String s, int max) {
        if (s == null) return "";
        s = s.trim();
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }
}
