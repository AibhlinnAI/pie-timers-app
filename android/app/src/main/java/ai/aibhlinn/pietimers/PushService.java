package ai.aibhlinn.pietimers;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Receives a milestone alert sent by the server while the app is closed.
 *
 * The site's notify-milestones function works out when each alert is due
 * and sends it through Firebase Cloud Messaging as a data message with
 * three fields: title, body and tag (supabase/functions/notify-milestones/
 * fcm.ts). Android starts this service for it whether or not the app is
 * running, and the notification is built here, the same way as one the
 * page asks for.
 */
public class PushService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        Notifier.show(this, data.get("title"), data.get("body"), data.get("tag"), MainActivity.isVisible());
    }

    /* Firebase replaces a device's token now and then. Nothing is done
       here, because only the page can save one: it holds the sign-in. The
       page asks for the token each time the app opens and saves it again
       (refreshSubscription in app/notify.js), and the server deletes the
       old one the first time Google says it is gone. Until the app is next
       opened, alerts to this phone stop. */
    @Override
    public void onNewToken(@NonNull String token) {
        // See above.
    }
}
