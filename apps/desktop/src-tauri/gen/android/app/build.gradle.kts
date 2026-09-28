import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val releaseSigningValues = mapOf(
    "GARDEN_ANDROID_KEYSTORE" to System.getenv("GARDEN_ANDROID_KEYSTORE"),
    "GARDEN_ANDROID_KEYSTORE_PASSWORD" to System.getenv("GARDEN_ANDROID_KEYSTORE_PASSWORD"),
    "GARDEN_ANDROID_KEY_ALIAS" to System.getenv("GARDEN_ANDROID_KEY_ALIAS"),
    "GARDEN_ANDROID_KEY_PASSWORD" to System.getenv("GARDEN_ANDROID_KEY_PASSWORD")
)
val hasAnyReleaseSigningValue = releaseSigningValues.values.any { !it.isNullOrBlank() }
val hasCompleteReleaseSigning = releaseSigningValues.values.all { !it.isNullOrBlank() }
if (hasAnyReleaseSigningValue && !hasCompleteReleaseSigning) {
    throw GradleException(
        "Android release signing is partially configured; provide all GARDEN_ANDROID_* signing values"
    )
}

android {
    compileSdk = 36
    namespace = "org.garden.ai"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "org.garden.ai"
        minSdk = 26
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (hasCompleteReleaseSigning) {
            create("release") {
                storeFile = file(releaseSigningValues.getValue("GARDEN_ANDROID_KEYSTORE")!!)
                storePassword =
                    releaseSigningValues.getValue("GARDEN_ANDROID_KEYSTORE_PASSWORD")!!
                keyAlias = releaseSigningValues.getValue("GARDEN_ANDROID_KEY_ALIAS")!!
                keyPassword = releaseSigningValues.getValue("GARDEN_ANDROID_KEY_PASSWORD")!!
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            if (hasCompleteReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

val patchTauriDocumentStartInjection by tasks.registering {
    doLast {
        val generatedWebView = file(
            "src/main/java/org/garden/ai/generated/RustWebView.kt"
        )
        val source = generatedWebView.readText()
        val upstream =
            "if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {"
        val patched =
            "if (false && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {"
        when {
            source.contains(patched) -> Unit
            source.contains(upstream) ->
                generatedWebView.writeText(source.replace(upstream, patched))
            else ->
                throw GradleException(
                    "The Wry Android document-start template changed; review the duplicate-injection workaround"
                )
        }
    }
}

tasks.matching {
    it.name.startsWith("compile") && it.name.endsWith("Kotlin")
}.configureEach {
    dependsOn(patchTauriDocumentStartInjection)
}

apply(from = "tauri.build.gradle.kts")
