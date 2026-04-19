package com.chatterbro.api

import com.chatterbro.data.bridge.KickBridgePaths
import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.model.ChannelChatBadge
import com.chatterbro.domain.model.ChannelChatMessage
import com.chatterbro.domain.model.ChannelChatSender
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.Json

class ApplicationModuleBadgeEnrichmentTest {
    @Test
    fun `enrichChannelChatWithSubscriberBadgeImages applies best matching subscriber badge image`() {
        val chat = ChannelChat(
            channelSlug = "opat04",
            displayName = "opat04",
            channelUrl = "https://kick.com/opat04",
            updatedAt = "2026-04-19T00:00:00Z",
            messages = listOf(
                createMessage(
                    messageId = "message-1",
                    username = "subscriberOne",
                    badges = listOf(
                        ChannelChatBadge(
                            type = "subscriber",
                            text = "Subscriber",
                            count = 1,
                            imageUrl = null,
                        ),
                    ),
                ),
                createMessage(
                    messageId = "message-2",
                    username = "subscriberFour",
                    badges = listOf(
                        ChannelChatBadge(
                            type = "subscriber",
                            text = "Subscriber",
                            count = 4,
                            imageUrl = null,
                        ),
                    ),
                ),
            ),
            pinnedMessage = createMessage(
                messageId = "pinned-1",
                username = "subscriberPinned",
                badges = listOf(
                    ChannelChatBadge(
                        type = "subscriber",
                        text = "Subscriber",
                        count = 7,
                        imageUrl = null,
                    ),
                ),
            ),
        )

        val enrichedChat = enrichChannelChatWithSubscriberBadgeImages(
            chat,
            mapOf(
                1 to "https://files.kick.com/channel_subscriber_badges/1/original",
                6 to "https://files.kick.com/channel_subscriber_badges/6/original",
            ),
        )

        assertEquals(
            "https://files.kick.com/channel_subscriber_badges/1/original",
            enrichedChat.messages[0].sender.badges[0].imageUrl,
        )
        assertEquals(
            "https://files.kick.com/channel_subscriber_badges/1/original",
            enrichedChat.messages[1].sender.badges[0].imageUrl,
        )
        assertEquals(
            "https://files.kick.com/channel_subscriber_badges/6/original",
            enrichedChat.pinnedMessage?.sender?.badges?.firstOrNull()?.imageUrl,
        )
        assertEquals(
            mapOf(
                1 to "https://files.kick.com/channel_subscriber_badges/1/original",
                6 to "https://files.kick.com/channel_subscriber_badges/6/original",
            ),
            enrichedChat.subscriberBadgeImageUrlsByMonths,
        )
    }

    @Test
    fun `enrichChannelChatWithSubscriberBadgeImages leaves non-subscriber badges untouched`() {
        val chat = ChannelChat(
            channelSlug = "opat04",
            displayName = "opat04",
            channelUrl = "https://kick.com/opat04",
            updatedAt = "2026-04-19T00:00:00Z",
            messages = listOf(
                createMessage(
                    messageId = "message-1",
                    username = "moderatorUser",
                    badges = listOf(
                        ChannelChatBadge(
                            type = "moderator",
                            text = "Moderator",
                            count = null,
                            imageUrl = null,
                        ),
                    ),
                ),
            ),
        )

        val enrichedChat = enrichChannelChatWithSubscriberBadgeImages(
            chat,
            mapOf(1 to "https://files.kick.com/channel_subscriber_badges/1/original"),
        )

        assertNull(enrichedChat.messages[0].sender.badges[0].imageUrl)
    }

    @Test
    fun `enrichChannelChatWithCachedBadgeAssets reuses stored sender badge images`() {
        val bridgePaths = KickBridgePaths(createTempDirectory("kick-badge-cache-test"))
        val cacheJson = Json {
            encodeDefaults = true
            ignoreUnknownKeys = true
        }
        bridgePaths.ensureDirectories()
        bridgePaths.chatCacheDirectory.createDirectories()
        bridgePaths.chatCacheDirectory.resolve("opat04.json").writeText(
            cacheJson.encodeToString(
                ChannelChat.serializer(),
                ChannelChat(
                    channelSlug = "opat04",
                    displayName = "opat04",
                    channelUrl = "https://kick.com/opat04",
                    updatedAt = "2026-04-19T00:00:00Z",
                    messages = listOf(
                        createMessage(
                            messageId = "cached-1",
                            username = "Skillabbm",
                            badges = listOf(
                                ChannelChatBadge(
                                    type = "size-[calc(1em*(18/13))]",
                                    text = "size-[calc(1em*(18/13))]",
                                    count = null,
                                    imageUrl = "data:image/svg+xml;base64,FOUNDERSVG",
                                ),
                                ChannelChatBadge(
                                    type = "size-[calc(1em*(18/13))]",
                                    text = "size-[calc(1em*(18/13))]",
                                    count = null,
                                    imageUrl = "https://files.kick.com/channel_subscriber_badges/549190/original",
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )

        val chat = ChannelChat(
            channelSlug = "opat04",
            displayName = "opat04",
            channelUrl = "https://kick.com/opat04",
            updatedAt = "2026-04-19T00:00:01Z",
            messages = listOf(
                createMessage(
                    messageId = "live-1",
                    username = "Skillabbm",
                    badges = listOf(
                        ChannelChatBadge(
                            type = "founder",
                            text = "Founder",
                            count = null,
                            imageUrl = null,
                        ),
                        ChannelChatBadge(
                            type = "subscriber",
                            text = "Subscriber",
                            count = 4,
                            imageUrl = null,
                        ),
                    ),
                ),
            ),
        )

        val enrichedChat = enrichChannelChatWithCachedBadgeAssets(chat, bridgePaths)

        assertEquals("data:image/svg+xml;base64,FOUNDERSVG", enrichedChat.messages[0].sender.badges[0].imageUrl)
        assertEquals(
            "https://files.kick.com/channel_subscriber_badges/549190/original",
            enrichedChat.messages[0].sender.badges[1].imageUrl,
        )
    }

    private fun createMessage(
        messageId: String,
        username: String,
        badges: List<ChannelChatBadge>,
    ): ChannelChatMessage {
        return ChannelChatMessage(
            id = messageId,
            content = "hello",
            type = "message",
            sender = ChannelChatSender(
                username = username,
                slug = username.lowercase(),
                badges = badges,
            ),
        )
    }
}