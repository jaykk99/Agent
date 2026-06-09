package com.example.data.dao

import androidx.room.*
import com.example.data.model.Message
import com.example.data.model.ApiTemplate
import com.example.data.model.Settings
import kotlinx.coroutines.flow.Flow

@Dao
interface AgentDao {
    // --- Messages ---
    @Query("SELECT * FROM messages ORDER BY timestamp ASC")
    fun getAllMessagesFlow(): Flow<List<Message>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertMessage(message: Message): Long

    @Query("DELETE FROM messages")
    suspend fun clearAllMessages()

    // --- API Templates ---
    @Query("SELECT * FROM api_templates ORDER BY name ASC")
    fun getAllApiTemplatesFlow(): Flow<List<ApiTemplate>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertApiTemplate(template: ApiTemplate)

    @Delete
    suspend fun deleteApiTemplate(template: ApiTemplate)

    @Query("DELETE FROM api_templates")
    suspend fun clearApiTemplates()

    // --- Settings ---
    @Query("SELECT * FROM settings WHERE id = 1 LIMIT 1")
    fun getSettingsFlow(): Flow<Settings?>

    @Query("SELECT * FROM settings WHERE id = 1 LIMIT 1")
    suspend fun getSettings(): Settings?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertSettings(settings: Settings)

    // --- Service Connections ---
    @Query("SELECT * FROM service_connections ORDER BY serviceName ASC")
    fun getAllServiceConnectionsFlow(): Flow<List<com.example.data.model.ServiceConnection>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertServiceConnection(connection: com.example.data.model.ServiceConnection)

    @Delete
    suspend fun deleteServiceConnection(connection: com.example.data.model.ServiceConnection)
}
