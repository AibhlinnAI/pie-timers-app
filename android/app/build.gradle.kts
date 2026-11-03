plugins {
    id("com.android.application")
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
        versionCode = 4
        versionName = "1.0.3"
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
}
