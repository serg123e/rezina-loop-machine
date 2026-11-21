plugins {
    id("com.android.application")
}

// Prototype: no libraries at all — the synth is plain AudioTrack, the UI is one custom View.
android {
    namespace = "it.automate123.rezina"
    compileSdk = 37

    defaultConfig {
        applicationId = "it.automate123.rezina"
        minSdk = 26 // AudioTrack low-latency performance mode
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
    }

    // Release key comes from the environment (CI secrets); without it only debug builds work.
    signingConfigs {
        create("release") {
            System.getenv("REZINA_KEYSTORE")?.let { storeFile = file(it) }
            storePassword = System.getenv("REZINA_KEYSTORE_PASSWORD")
            keyAlias = "rezina"
            keyPassword = System.getenv("REZINA_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            if (System.getenv("REZINA_KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}
