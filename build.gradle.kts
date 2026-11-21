// AGP 9 compiles Kotlin itself; the Kotlin plugin is declared only to pin its version.
plugins {
    id("com.android.application") version "9.5.1" apply false
    id("org.jetbrains.kotlin.jvm") version "2.4.21" apply false
}
