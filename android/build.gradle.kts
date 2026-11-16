plugins {
    id("com.android.application") version "9.5.0" apply false
    // Reads app/google-services.json (Firebase, for phone notifications).
    id("com.google.gms.google-services") version "4.5.0" apply false
}

/* This folder can sit on Google Drive, and build output is thousands of
   files that change on every build. Where LOCALAPPDATA exists (Windows),
   it goes to local disk instead, so Drive never syncs it. */
System.getenv("LOCALAPPDATA")?.let { local ->
    allprojects {
        layout.buildDirectory.set(file("$local/pie-timers-android-build/${project.name}"))
    }
}
