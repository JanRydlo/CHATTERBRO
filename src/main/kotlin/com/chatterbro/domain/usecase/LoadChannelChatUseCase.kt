package com.chatterbro.domain.usecase

import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.model.ChannelChatRequest
import com.chatterbro.domain.repository.KickRepository

class LoadChannelChatUseCase(
    private val kickRepository: KickRepository,
) {
    suspend operator fun invoke(request: ChannelChatRequest): ChannelChat {
        return kickRepository.getChannelChat(request)
    }
}