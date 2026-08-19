# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# Rust reaches BiometricGate through JNI (FindClass + GetStaticMethodID in
# src/secrets/gate.rs). R8 cannot see those references, so in a minified build it
# strips or renames the static methods and the gate silently degrades to
# "unavailable" — no biometric prompt in release while debug prompts fine.
-keep class work.allr.app.BiometricGate { public static <methods>; }
