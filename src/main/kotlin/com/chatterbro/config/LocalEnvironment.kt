package com.chatterbro.config

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

object LocalEnvironment {
    fun read(
        key: String,
        environment: Map<String, String> = System.getenv(),
        envFile: Path = Paths.get(".env"),
    ): String? {
        return environment[key]
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?: load(envFile)[key]
                ?.trim()
                ?.takeIf(String::isNotEmpty)
    }

    internal fun load(envFile: Path): Map<String, String> {
        if (!Files.exists(envFile)) {
            return emptyMap()
        }

        return Files.readAllLines(envFile)
            .map(String::trim)
            .filter(String::isNotEmpty)
            .filterNot { it.startsWith("#") }
            .mapNotNull(::parseEntry)
            .toMap()
    }

    private fun parseEntry(line: String): Pair<String, String>? {
        val normalizedLine = if (line.startsWith("export ")) {
            line.removePrefix("export ").trim()
        } else {
            line
        }

        val separatorIndex = normalizedLine.indexOf('=')
        if (separatorIndex <= 0) {
            return null
        }

        val key = normalizedLine.substring(0, separatorIndex).trim()
        if (key.isEmpty()) {
            return null
        }

        val rawValue = normalizedLine.substring(separatorIndex + 1).trim()
        val value = when {
            rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"') -> {
                rawValue.substring(1, rawValue.length - 1)
            }

            rawValue.length >= 2 && rawValue.startsWith('\'') && rawValue.endsWith('\'') -> {
                rawValue.substring(1, rawValue.length - 1)
            }

            else -> rawValue
        }

        return key to value
    }
}