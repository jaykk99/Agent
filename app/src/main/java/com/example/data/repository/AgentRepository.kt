package com.example.data.repository

import com.example.data.dao.AgentDao
import com.example.data.model.Message
import com.example.data.model.ApiTemplate
import com.example.data.model.Settings
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first

class AgentRepository(private val agentDao: AgentDao) {

    val messagesFlow: Flow<List<Message>> = agentDao.getAllMessagesFlow()
    val apiTemplatesFlow: Flow<List<ApiTemplate>> = agentDao.getAllApiTemplatesFlow()
    val settingsFlow: Flow<Settings?> = agentDao.getSettingsFlow()
    val serviceConnectionsFlow: Flow<List<com.example.data.model.ServiceConnection>> = agentDao.getAllServiceConnectionsFlow()

    suspend fun getSettings(): Settings {
        return agentDao.getSettings() ?: Settings().also {
            agentDao.insertSettings(it)
        }
    }

    suspend fun updateSettings(settings: Settings) {
        agentDao.insertSettings(settings)
    }

    suspend fun insertMessage(message: Message): Long {
        return agentDao.insertMessage(message)
    }

    suspend fun clearChat() {
        agentDao.clearAllMessages()
    }

    suspend fun insertApiTemplate(template: ApiTemplate) {
        agentDao.insertApiTemplate(template)
    }

    suspend fun deleteApiTemplate(template: ApiTemplate) {
        agentDao.deleteApiTemplate(template)
    }

    suspend fun insertServiceConnection(connection: com.example.data.model.ServiceConnection) {
        agentDao.insertServiceConnection(connection)
    }

    suspend fun deleteServiceConnection(connection: com.example.data.model.ServiceConnection) {
        agentDao.deleteServiceConnection(connection)
    }

    suspend fun clearApiTemplates() {
        agentDao.clearApiTemplates()
    }

    suspend fun seedDefaultConnectors() {
        try {
            val current = agentDao.getAllApiTemplatesFlow().first()
            if (current.isEmpty()) {
                val defaults = listOf(
                    ApiTemplate(
                        name = "Safe Joke Finder",
                        url = "https://v2.jokeapi.dev/joke/Any?safe-mode",
                        method = "GET",
                        headersJson = "{\"Accept\":\"application/json\"}",
                        paramsJson = "{}",
                        description = "Fetches a clean, random joke on demand."
                    ),
                    ApiTemplate(
                        name = "Bitcoin Price Tracker",
                        url = "https://api.coindesk.com/v1/bpi/currentprice.json",
                        method = "GET",
                        headersJson = "{}",
                        paramsJson = "{}",
                        description = "Returns real-time prices for Bitcoin in USD, GBP, and EUR."
                    ),
                    ApiTemplate(
                        name = "Daily Life Advice",
                        url = "https://api.adviceslip.com/advice",
                        method = "GET",
                        headersJson = "{}",
                        paramsJson = "{}",
                        description = "Returns small, practical pieces of advice for everyday living."
                    ),
                    ApiTemplate(
                        name = "HTTP Bin Post Echo",
                        url = "https://httpbin.org/post",
                        method = "POST",
                        headersJson = "{\"Content-Type\":\"application/json\"}",
                        paramsJson = "{}",
                        bodyTemplate = "{\"message\":\"hello from omni api agent\",\"client\":\"android\"}",
                        description = "Test dynamic HTTP POST requests. Echoes back headers and request body."
                    )
                )
                defaults.forEach { agentDao.insertApiTemplate(it) }
            }
        } catch (e: Exception) {
            // Safe fallback
        }
    }
}
