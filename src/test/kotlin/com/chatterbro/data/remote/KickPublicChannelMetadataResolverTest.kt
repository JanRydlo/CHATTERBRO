package com.chatterbro.data.remote

import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class KickPublicChannelMetadataResolverTest {
    @Test
    fun `parseChannelMetadata extracts ids from decoded html`() {
        val resolver = KickPublicChannelMetadataResolver(createTempDirectory("kick-public-metadata-test"))
        val html = """
            <html>
            <body>
            <h1 id="channel-username">Mikeses</h1>
            <script type="application/json">
            {"slug":"mikeses","id":7600542,"chatroom":{"id":7512157},"broadcaster_user_id":8351704,"profile_pic":"https://files.kick.com/images/user/8351704/profile_image/conversion/example-fullsize.webp","is_live":true}
            </script>
            </body>
            </html>
        """.trimIndent()

        val metadata = resolver.parseChannelMetadata(html, "mikeses")

        assertNotNull(metadata)
        assertEquals("mikeses", metadata.channelSlug)
        assertEquals(7600542, metadata.channelId)
        assertEquals(7512157, metadata.chatroomId)
        assertEquals(8351704, metadata.broadcasterUserId)
        assertEquals("Mikeses", metadata.displayName)
        assertEquals(true, metadata.isLive)
        assertTrue(metadata.avatarUrl?.contains("/images/user/8351704/") == true)
    }

    @Test
    fun `parseChannelMetadata decodes next flight payload`() {
        val resolver = KickPublicChannelMetadataResolver(createTempDirectory("kick-public-metadata-flight-test"))
        val html = """
            <html>
            <body>
            <h1 id="channel-username">opat04</h1>
            <script>
            self.__next_f.push([1,"0:{\"slug\":\"opat04\",\"id\":10455248,\"chatroom\":{\"id\":10297694},\"broadcaster_user_id\":11214657,\"profile_pic\":\"https://files.kick.com/images/user/11214657/profile_image/conversion/example-fullsize.webp\",\"is_live\":true}"])
            </script>
            </body>
            </html>
        """.trimIndent()

        val metadata = resolver.parseChannelMetadata(html, "opat04")

        assertNotNull(metadata)
        assertEquals(10455248, metadata.channelId)
        assertEquals(10297694, metadata.chatroomId)
        assertEquals(11214657, metadata.broadcasterUserId)
        assertEquals(true, metadata.isLive)
    }

    @Test
    fun `parseChannelMetadata extracts subscriber badge image urls`() {
        val resolver = KickPublicChannelMetadataResolver(createTempDirectory("kick-public-metadata-subscriber-badges-test"))
        val html = """
            <html>
            <body>
            <h1 id="channel-username">opat04</h1>
            <script type="application/json">
            {"slug":"opat04","id":10455248,"chatroom":{"id":10297694},"subscriber_badges":[{"id":549190,"channel_id":10455248,"months":1,"badge_image":{"srcset":"","src":"https://files.kick.com/channel_subscriber_badges/549190/original"}},{"id":549191,"channel_id":10455248,"months":3,"badge_image":{"srcset":"","src":"https://files.kick.com/channel_subscriber_badges/549191/original"}}]}
            </script>
            </body>
            </html>
        """.trimIndent()

        val metadata = resolver.parseChannelMetadata(html, "opat04")

        assertNotNull(metadata)
        assertEquals(
            mapOf(
                1 to "https://files.kick.com/channel_subscriber_badges/549190/original",
                3 to "https://files.kick.com/channel_subscriber_badges/549191/original",
            ),
            metadata.subscriberBadgeImageUrlsByMonths,
        )
    }
}