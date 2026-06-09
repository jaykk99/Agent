package com.example.data.network

import android.util.Log
import com.example.data.model.Message
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object NetworkManager {
    private const val TAG = "NetworkManager"
    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(60, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    /**
     * Executes a dynamic HTTP API call on any URL.
     */
    suspend fun executeDynamicApiCall(
        url: String,
        method: String,
        headers: Map<String, String>,
        queryParams: Map<String, String>,
        body: String?
    ): DynamicApiResponse = withContext(Dispatchers.IO) {
        try {
            // Ensure schema exists, default to https if not specified
            var cleanUrl = url.trim()
            if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
                cleanUrl = "https://$cleanUrl"
            }

            val urlParser = cleanUrl.toHttpUrlOrNull()
            if (urlParser == null) {
                return@withContext DynamicApiResponse(
                    success = false,
                    statusCode = -1,
                    body = "Invalid URL structure: $cleanUrl",
                    headers = emptyMap()
                )
            }

            val urlBuilder = urlParser.newBuilder()
            queryParams.forEach { (key, value) ->
                if (key.isNotBlank()) {
                    urlBuilder.addQueryParameter(key, value)
                }
            }
            val finalUrl = urlBuilder.build()

            // Build request
            val requestBuilder = Request.Builder().url(finalUrl)

            // Add headers
            headers.forEach { (key, value) ->
                if (key.isNotBlank()) {
                    requestBuilder.addHeader(key, value)
                }
            }

            val methodUpper = method.uppercase()
            // Set method and body
            val requestBody = if (methodUpper == "POST" || methodUpper == "PUT" || methodUpper == "PATCH") {
                (body ?: "").toRequestBody(JSON_MEDIA_TYPE)
            } else {
                null
            }
            requestBuilder.method(methodUpper, requestBody)

            val request = requestBuilder.build()

            client.newCall(request).execute().use { response ->
                val responseBody = response.body?.string() ?: ""
                val responseHeaders = mutableMapOf<String, String>()
                response.headers.forEach { pair ->
                    responseHeaders[pair.first] = pair.second
                }
                DynamicApiResponse(
                    success = response.isSuccessful,
                    statusCode = response.code,
                    body = responseBody,
                    headers = responseHeaders
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error executing dynamic API call: ${e.message}", e)
            DynamicApiResponse(
                success = false,
                statusCode = -999,
                body = "Error Details: ${e.localizedMessage ?: "Unknown network error"}",
                headers = emptyMap()
            )
        }
    }

    /**
     * Helper response class for Dynamic API calls
     */
    data class DynamicApiResponse(
        val success: Boolean,
        val statusCode: Int,
        val body: String,
        val headers: Map<String, String>
    )

    /**
     * Fetches user profile from GitHub API
     */
    suspend fun fetchGitHubProfile(token: String): GitHubProfileResponse = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("https://api.github.com/user")
                .addHeader("Authorization", "Bearer $token")
                .addHeader("Accept", "application/vnd.github+json")
                .addHeader("User-Agent", "API-AI-Agent-App")
                .build()

            client.newCall(request).execute().use { response ->
                val body = response.body?.string() ?: ""
                if (response.isSuccessful) {
                    val json = JSONObject(body)
                    GitHubProfileResponse(
                        success = true,
                        username = json.optString("login", "Unknown User"),
                        avatarUrl = json.optString("avatar_url", ""),
                        bio = json.optString("bio", "No bio provided"),
                        followers = json.optInt("followers", 0),
                        publicRepos = json.optInt("public_repos", 0)
                    )
                } else {
                    GitHubProfileResponse(success = false, error = "GitHub API returned ${response.code}: $body")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching GitHub Profile: ${e.message}", e)
            GitHubProfileResponse(success = false, error = e.localizedMessage)
        }
    }

    /**
     * Fetches repositories from GitHub API
     */
    suspend fun fetchGitHubRepos(token: String): List<GitHubRepo> = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("https://api.github.com/user/repos?sort=updated&per_page=10")
                .addHeader("Authorization", "Bearer $token")
                .addHeader("Accept", "application/vnd.github+json")
                .addHeader("User-Agent", "API-AI-Agent-App")
                .build()

                client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    val body = response.body?.string() ?: ""
                    val jsonArray = JSONArray(body)
                    val repos = mutableListOf<GitHubRepo>()
                    for (i in 0 until jsonArray.length()) {
                        val obj = jsonArray.getJSONObject(i)
                        repos.add(
                            GitHubRepo(
                                name = obj.optString("name", ""),
                                fullName = obj.optString("full_name", ""),
                                description = obj.optString("description", "No description"),
                                stars = obj.optInt("stargazers_count", 0),
                                language = obj.optString("language", "Unknown"),
                                htmlUrl = obj.optString("html_url", "")
                            )
                        )
                    }
                    repos
                } else emptyList()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching GitHub Repos: ${e.message}", e)
            emptyList()
        }
    }

    data class GitHubProfileResponse(
        val success: Boolean,
        val username: String = "",
        val avatarUrl: String = "",
        val bio: String = "",
        val followers: Int = 0,
        val publicRepos: Int = 0,
        val error: String? = null
    )

    data class GitHubRepo(
        val name: String,
        val fullName: String,
        val description: String,
        val stars: Int,
        val language: String,
        val htmlUrl: String
    )
    
    data class GitHubTokenResponse(
        val success: Boolean,
        val token: String? = null,
        val error: String? = null
    )

    suspend fun exchangeGitHubCode(code: String, clientId: String, clientSecret: String): GitHubTokenResponse = withContext(Dispatchers.IO) {
        try {
            val url = "https://github.com/login/oauth/access_token"
            val formBody = okhttp3.FormBody.Builder()
                .add("client_id", clientId)
                .add("client_secret", clientSecret)
                .add("code", code)
                .build()

            val request = Request.Builder()
                .url(url)
                .post(formBody)
                .addHeader("Accept", "application/json")
                .build()

            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    val body = response.body?.string() ?: ""
                    val json = JSONObject(body)
                    // If error exists
                    if (json.has("error")) {
                        return@use GitHubTokenResponse(false, error = json.optString("error_description"))
                    } else {
                        val token = json.optString("access_token")
                        if (token.isNotEmpty()) {
                            return@use GitHubTokenResponse(true, token = token)
                        } else {
                            return@use GitHubTokenResponse(false, error = "Empty token returned.")
                        }
                    }
                } else {
                    GitHubTokenResponse(false, error = "HTTP ${response.code}")
                }
            }
        } catch (e: Exception) {
            GitHubTokenResponse(false, error = e.localizedMessage)
        }
    }

    suspend fun fetchGitHubFileContent(token: String, repoFullName: String, filePath: String): String? = withContext(Dispatchers.IO) {
        try {
            // Note: Use raw GitHub content URL or API
            val request = Request.Builder()
                .url("https://raw.githubusercontent.com/$repoFullName/main/$filePath")
                .addHeader("Authorization", "Bearer $token")
                .build()
                
            client.newCall(request).execute().use { response ->
                 if (response.isSuccessful) {
                     response.body?.string()
                 } else {
                     // fallback to master
                     val fbRequest = Request.Builder()
                         .url("https://raw.githubusercontent.com/$repoFullName/master/$filePath")
                         .addHeader("Authorization", "Bearer $token")
                         .build()
                     client.newCall(fbRequest).execute().use { fbRes ->
                         if (fbRes.isSuccessful) fbRes.body?.string() else null
                     }
                 }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching github file", e)
            null
        }
    }

    /**
     * Generates content using the chosen model settings and credentials (either Gemini REST API or OpenAI custom API)
     */
    suspend fun generateAiContent(
        prompt: String,
        systemPrompt: String,
        activeModel: String,
        isCustomGeminiEnabled: Boolean,
        customGeminiKey: String,
        defaultGeminiKey: String,
        isCustomModelEnabled: Boolean,
        customEndpoint: String,
        customKey: String,
        customModelName: String,
        conversationHistory: List<Message> = emptyList()
    ): String = withContext(Dispatchers.IO) {
        if (isCustomModelEnabled && customEndpoint.isNotBlank()) {
            generateOpenAiCompatibleContent(prompt, systemPrompt, customEndpoint, customKey, customModelName, conversationHistory)
        } else {
            val resolvedKey = if (isCustomGeminiEnabled && customGeminiKey.isNotBlank()) {
                customGeminiKey
            } else {
                defaultGeminiKey
            }
            generateGeminiContent(prompt, systemPrompt, activeModel, resolvedKey, conversationHistory)
        }
    }

    private fun generateGeminiContent(
        prompt: String,
        systemPrompt: String,
        modelName: String,
        apiKey: String,
        conversationHistory: List<Message>
    ): String {
        if (apiKey.isBlank() || apiKey == "MY_GEMINI_API_KEY") {
            return "Error: Gemini API Key is missing. Please add your key in the Model tab."
        }

        val url = "https://generativelanguage.googleapis.com/v1beta/models/$modelName:generateContent?key=$apiKey"

        try {
            val root = JSONObject()
            val contentsArr = JSONArray()
            
            // Add conversation history context
            val historyToInclude = conversationHistory.takeLast(10)
            historyToInclude.forEach { msg ->
                // Filter out large dynamic response structures to save token window
                val cleanText = if (msg.apiCallUrl != null) {
                    "${msg.text}\n[API Executed: ${msg.apiCallMethod} ${msg.apiCallUrl} returning Status ${msg.apiCallStatus}]"
                } else {
                    msg.text
                }
                
                val turn = JSONObject()
                turn.put("role", if (msg.isUser) "user" else "model")
                val parts = JSONArray()
                val pt = JSONObject()
                pt.put("text", cleanText)
                parts.put(pt)
                turn.put("parts", parts)
                contentsArr.put(turn)
            }

            // Current prompt
            val finalTurn = JSONObject()
            finalTurn.put("role", "user")
            val parts = JSONArray()
            val pt = JSONObject()
            pt.put("text", prompt)
            parts.put(pt)
            finalTurn.put("parts", parts)
            contentsArr.put(finalTurn)

            root.put("contents", contentsArr)

            // System Instruction
            if (systemPrompt.isNotBlank()) {
                val systemInstructionObj = JSONObject()
                val partsArr = JSONArray()
                partsArr.put(JSONObject().put("text", systemPrompt))
                systemInstructionObj.put("parts", partsArr)
                root.put("systemInstruction", systemInstructionObj)
            }

            // Generation config
            val genConfig = JSONObject()
            genConfig.put("temperature", 0.7)
            root.put("generationConfig", genConfig)

            val bodyRequestBody = root.toString().toRequestBody(JSON_MEDIA_TYPE)
            val request = Request.Builder()
                .url(url)
                .post(bodyRequestBody)
                .build()

            client.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    val errMsg = JSONObject(bodyStr).optJSONObject("error")?.optString("message", "Unknown error")
                        ?: "HTTP Error ${response.code}"
                    return "Error: $errMsg"
                }

                val resJson = JSONObject(bodyStr)
                val candidates = resJson.optJSONArray("candidates")
                if (candidates != null && candidates.length() > 0) {
                    val firstCandidate = candidates.getJSONObject(0)
                    val contentObj = firstCandidate.optJSONObject("content")
                    val partsRes = contentObj?.optJSONArray("parts")
                    if (partsRes != null && partsRes.length() > 0) {
                        return partsRes.getJSONObject(0).optString("text", "No text in response.")
                    }
                }
                return "Error: Received empty response from Gemini API."
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error invoking Gemini: ${e.message}", e)
            return "Error calling Gemini: ${e.localizedMessage ?: "Unknown exception"}"
        }
    }

    private fun generateOpenAiCompatibleContent(
        prompt: String,
        systemPrompt: String,
        endpointUrl: String,
        apiKey: String,
        modelName: String,
        conversationHistory: List<Message>
    ): String {
        var cleanUrl = endpointUrl.trim()
        if (!cleanUrl.endsWith("/")) {
            cleanUrl += "/"
        }
        val finalUrl = if (!cleanUrl.contains("chat/completions")) {
            cleanUrl + "chat/completions"
        } else {
            cleanUrl
        }

        try {
            val root = JSONObject()
            root.put("model", modelName.ifBlank { "gpt-4o" })

            val messagesArr = JSONArray()

            // System prompt
            if (systemPrompt.isNotBlank()) {
                messagesArr.put(
                    JSONObject()
                        .put("role", "system")
                        .put("content", systemPrompt)
                )
            }

            // Conversation history
            conversationHistory.takeLast(10).forEach { msg ->
                val cleanText = if (msg.apiCallUrl != null) {
                    "${msg.text}\n[API Executed: ${msg.apiCallMethod} ${msg.apiCallUrl} returning Status ${msg.apiCallStatus}]"
                } else {
                    msg.text
                }
                messagesArr.put(
                    JSONObject()
                        .put("role", if (msg.isUser) "user" else "assistant")
                        .put("content", cleanText)
                )
            }

            // Current prompt
            messagesArr.put(
                JSONObject()
                    .put("role", "user")
                    .put("content", prompt)
            )

            root.put("messages", messagesArr)

            val bodyRequestBody = root.toString().toRequestBody(JSON_MEDIA_TYPE)
            val requestBuilder = Request.Builder()
                .url(finalUrl)
                .post(bodyRequestBody)

            if (apiKey.isNotBlank()) {
                requestBuilder.addHeader("Authorization", "Bearer $apiKey")
            }

            val request = requestBuilder.build()
            client.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    val errMsg = JSONObject(bodyStr).optJSONObject("error")?.optString("message", "Unknown error")
                        ?: "HTTP Error ${response.code}: $bodyStr"
                    return "Error: $errMsg"
                }

                val resJson = JSONObject(bodyStr)
                val choices = resJson.optJSONArray("choices")
                if (choices != null && choices.length() > 0) {
                    val firstChoice = choices.getJSONObject(0)
                    val msgObj = firstChoice.optJSONObject("message")
                    val content = msgObj?.optString("content", "") ?: ""
                    if (content.isNotBlank()) {
                        return content
                    }
                }
                return "Error: Empty response returned from OpenAI-compatible API."
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error invoking OpenAI custom: ${e.message}", e)
            return "Error calling Custom endpoint: ${e.localizedMessage ?: "Unknown exception"}"
        }
    }
}
