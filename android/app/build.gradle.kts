plugins {
    id("com.android.application")
    // Needs app/google-services.json, which is NOT in this repo: see
    // "Firebase" in android/README.md. The build stops without it.
    id("com.google.gms.google-services")
}

android {
    namespace = "ai.aibhlinn.pietimers"
    compileSdk = 36

    defaultConfig {
        // The Play listing's identity. Never change it.
        applicationId = "ai.aibhlinn.pietimers"
        // Release 3 (the TWA) needed Android 7; keep the same devices.
        minSdk = 24
        targetSdk = 36
        // One higher than any version code ever uploaded to Play, including
        // a bundle whose draft release was then discarded. 3 was the last.
        versionCode = 5
        versionName = "1.0.4"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
        debug {
            // Installs beside the Play app, so a test build never replaces it.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // Brings androidx.core (insets, edge to edge) at a version that still
    // compiles against API 36. core 1.19 needs compileSdk 37.
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.core:core-splashscreen:1.2.0")

    // Firebase Cloud Messaging only: milestone alerts while the app is
    // closed. No Analytics. The BoM picks the version.
    implementation(platform("com.google.firebase:firebase-bom:35.1.0"))
    implementation("com.google.firebase:firebase-messaging")
    // The app has no fragments. Firebase's Play services libraries bring
    // in a Fragment library from before 1.3.0, and with that one present
    // the activity's permission prompt and file dialogs can lose their
    // answers. Lint stops the release build over it; this lifts it.
    implementation("androidx.fragment:fragment:1.8.9")
}
