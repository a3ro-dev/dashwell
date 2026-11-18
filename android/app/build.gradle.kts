plugins { id("com.android.application") }

android {
    namespace = "dev.a3ro.tumblrnew"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.a3ro.dashwell"
        minSdk = 24
        targetSdk = 36
        versionCode = 7
        versionName = "1.1.5"
    }
    // The extension is the single source of truth: its files ship as app assets.
    sourceSets["main"].assets.srcDirs("src/main/assets", "../../extension")

    // Release signing comes from ~/.gradle/gradle.properties so the key never enters the repo.
    val ks = providers.gradleProperty("TN_KEYSTORE").orNull
    signingConfigs {
        if (ks != null) create("release") {
            storeFile = file(ks)
            storePassword = providers.gradleProperty("TN_KEYSTORE_PASSWORD").get()
            keyAlias = "dashwell"
            keyPassword = providers.gradleProperty("TN_KEYSTORE_PASSWORD").get()
        }
    }
    buildTypes {
        // Debug builds get their own ID so they never collide with (and force uninstalling) the release.
        debug { applicationIdSuffix = ".debug" }
        release {
            isMinifyEnabled = false
            if (ks != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies { implementation("androidx.webkit:webkit:1.14.0") }
