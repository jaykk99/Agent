package com.example.data.model

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "messages")
data class Message(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val text: String,
    val isUser: Boolean,
    val timestamp: Long = System.currentTimeMillis(),
    val status: String = "SUCCESS", // "SENDING", "SUCCESS", "ERROR"
    val apiCallUrl: String? = null,
    val apiCallMethod: String? = null,
    val apiCallResponse: String? = null,
    val apiCallStatus: Int? = null // status code e.g. 200
)

@Entity(tableName = "api_templates")
data class ApiTemplate(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,
    val url: String,
    val method: String = "GET",
    val headersJson: String = "{}", // JSON or key-value format
    val paramsJson: String = "{}",  // JSON or key-value format
    val bodyTemplate: String? = null,
    val description: String = ""
)

@Entity(tableName = "service_connections")
data class ServiceConnection(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val serviceName: String,
    val apiKey: String,
    val addedAt: Long = System.currentTimeMillis()
)

@Entity(tableName = "settings")
data class Settings(
    @PrimaryKey val id: Int = 1, // Single row
    val isCustomGeminiKeyEnabled: Boolean = false,
    val customGeminiApiKey: String = "",
    val activeModelName: String = "gemini-3.5-flash", 
    val isCustomModelEnabled: Boolean = false,
    val customModelEndpoint: String = "",
    val customModelApiKey: String = "",
    val customModelName: String = "",
    val gitHubToken: String = "",
    val gitHubUsername: String = "",
    val gitHubAvatarUrl: String = "",
    val isGitHubConnected: Boolean = false
)
