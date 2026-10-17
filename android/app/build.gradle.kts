plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing comes from CI secrets; see .github/workflows/android.yml.
val keystorePath: String? = System.getenv("WIDGET_KEYSTORE_PATH")
val keystorePassword: String? = System.getenv("WIDGET_KEYSTORE_PASSWORD")

android {
    namespace = "com.kbsimple.levelingup"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.kbsimple.levelingup"
        minSdk = 26
        targetSdk = 36
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "0.1.$versionCode"
    }

    signingConfigs {
        if (keystorePath != null && keystorePassword != null) {
            create("release") {
                storeFile = file(keystorePath)
                storeType = "pkcs12"
                storePassword = keystorePassword
                keyAlias = "widget"
                keyPassword = keystorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        unitTests.all {
            // Shared with the web app's tests.
            it.systemProperty("fixturesDir", rootProject.file("../fixtures").absolutePath)
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("androidx.glance:glance-appwidget:1.1.1")
    implementation("androidx.work:work-runtime-ktx:2.11.2")

    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in local unit tests; use the real one.
    testImplementation("org.json:json:20260814")
}
