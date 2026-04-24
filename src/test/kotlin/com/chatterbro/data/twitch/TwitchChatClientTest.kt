package com.chatterbro.data.twitch

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TwitchChatClientTest {
    private val client = TwitchChatClient()

    @Test
    fun `buildPrivmsgCommand omits reply tag when no parent id is provided`() {
        val command = client.buildPrivmsgCommand(
            channelSlug = "someStreamer",
            content = "Hello Twitch",
            replyToMessageId = null,
        )

        assertEquals("PRIVMSG #somestreamer :Hello Twitch", command)
        assertFalse(command.startsWith("@reply-parent-msg-id="))
    }

    @Test
    fun `buildPrivmsgCommand includes reply tag when parent id is provided`() {
        val command = client.buildPrivmsgCommand(
            channelSlug = "someStreamer",
            content = "Replying now",
            replyToMessageId = "abc-123",
        )

        assertTrue(command.startsWith("@reply-parent-msg-id=abc-123 "))
        assertEquals("@reply-parent-msg-id=abc-123 PRIVMSG #somestreamer :Replying now", command)
    }
}