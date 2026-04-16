plugins {
    application
    kotlin("jvm") version "2.3.20"
    kotlin("plugin.serialization") version "2.3.20"
}

val frontendDirectory = rootDir.resolve("frontend")
val frontendSourceDirectory = frontendDirectory.resolve("src")
val frontendDistDirectory = frontendDirectory.resolve("dist")
val npmExecutable = if (System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) {
    "npm.cmd"
} else {
    "npm"
}

group = "com.chatterbro"
version = "0.1.0-SNAPSHOT"

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

kotlin {
    jvmToolchain(17)
}

application {
    mainClass = "com.chatterbro.MainKt"
}

dependencies {
    implementation("io.ktor:ktor-server-core-jvm:3.4.2")
    implementation("io.ktor:ktor-server-netty-jvm:3.4.2")
    implementation("io.ktor:ktor-server-content-negotiation-jvm:3.4.2")
    implementation("io.ktor:ktor-server-cors-jvm:3.4.2")
    implementation("io.ktor:ktor-server-call-logging-jvm:3.4.2")
    implementation("io.ktor:ktor-serialization-kotlinx-json-jvm:3.4.2")

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("org.slf4j:slf4j-simple:2.0.17")

    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}

val buildFrontend by tasks.registering(Exec::class) {
    group = "build"
    description = "Builds the React frontend bundle served by Ktor."
    workingDir = rootDir
    commandLine(npmExecutable, "--prefix", "frontend", "run", "build")

    inputs.dir(frontendSourceDirectory)
    inputs.file(frontendDirectory.resolve("package.json"))
    inputs.file(frontendDirectory.resolve("package-lock.json"))
    inputs.file(frontendDirectory.resolve("tsconfig.json"))
    inputs.file(frontendDirectory.resolve("tsconfig.node.json"))
    inputs.file(frontendDirectory.resolve("vite.config.ts"))
    outputs.dir(frontendDistDirectory)

    onlyIf {
        frontendDirectory.exists()
    }
}

tasks.named<JavaExec>("run") {
    dependsOn(buildFrontend)
    workingDir = rootDir
}

