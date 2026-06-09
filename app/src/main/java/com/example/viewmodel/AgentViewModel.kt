package com.example.viewmodel

import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.BuildConfig
import com.example.data.AppDatabase
import com.example.data.model.Message
import com.example.data.model.ApiTemplate
import com.example.data.model.Settings
import com.example.data.network.NetworkManager
import com.example.data.repository.AgentRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.regex.Pattern

class AgentViewModel(application: Application) : AndroidViewModel(application) {

    private val repository: AgentRepository
    
    val messagesState: StateFlow<List<Message>>
    val apiTemplatesState: StateFlow<List<ApiTemplate>>
    val settingsState: StateFlow<Settings>

    // Dynamic UI states
    private val _isAiThinking = MutableStateFlow(false)
    val isAiThinking: StateFlow<Boolean> = _isAiThinking.asStateFlow()

    private val _gitHubRepos = MutableStateFlow<List<NetworkManager.GitHubRepo>>(emptyList())
    val gitHubRepos: StateFlow<List<NetworkManager.GitHubRepo>> = _gitHubRepos.asStateFlow()

    private val _githubProfileError = MutableStateFlow<String?>(null)
    val githubProfileError: StateFlow<String?> = _githubProfileError.asStateFlow()

    private val _isGitHubLoading = MutableStateFlow(false)
    val isGitHubLoading: StateFlow<Boolean> = _isGitHubLoading.asStateFlow()

    private val _showConnectionPopupFor = MutableStateFlow<String?>(null)
    val showConnectionPopupFor: StateFlow<String?> = _showConnectionPopupFor.asStateFlow()

    val serviceConnectionsState: StateFlow<List<com.example.data.model.ServiceConnection>>

    private val _modelTestResult = MutableStateFlow<String?>(null)
    val modelTestResult: StateFlow<String?> = _modelTestResult.asStateFlow()

    private val _importStatus = MutableStateFlow<String?>(null)
    val importStatus: StateFlow<String?> = _importStatus.asStateFlow()

    init {
        val database = AppDatabase.getDatabase(application)
        repository = AgentRepository(database.agentDao())

        messagesState = repository.messagesFlow
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

        apiTemplatesState = repository.apiTemplatesFlow
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

        settingsState = repository.settingsFlow
            .map { it ?: Settings() }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), Settings())

        serviceConnectionsState = repository.serviceConnectionsFlow
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

        // Seed initial templates and sync GitHub if already token is saved
        viewModelScope.launch {
            repository.seedDefaultConnectors()
            val savedSettings = repository.getSettings()
            if (savedSettings.isGitHubConnected && savedSettings.gitHubToken.isNotBlank()) {
                refreshGitHubData(savedSettings.gitHubToken)
            }
        }
    }

    // --- Actions ---

    fun sendMessage(text: String) {
        if (text.isBlank()) return

        viewModelScope.launch {
            val settings = settingsState.value
            
            // 1. Save user message
            val userMsg = Message(text = text, isUser = true)
            repository.insertMessage(userMsg)

            _isAiThinking.value = true

            // 2. Scan if user wants to trigger an API or is typing a URL directly
            val (isApiMatch, method, parsedUrl, bodyContent) = detectApiRequest(text)

            var finalAiResponseText: String
            val apiMessageId: Long

            if (isApiMatch && parsedUrl != null) {
                // We matched or extracted a URL API call!
                // Insert API Loading placeholder
                val loaderMsg = Message(
                    text = "Connecting to ${method} ${parsedUrl}...",
                    isUser = false,
                    status = "SENDING",
                    apiCallUrl = parsedUrl,
                    apiCallMethod = method
                )
                apiMessageId = repository.insertMessage(loaderMsg)

                // Execute Dynamic Request
                val response = NetworkManager.executeDynamicApiCall(
                    url = parsedUrl,
                    method = method,
                    headers = getHeadersForCall(parsedUrl),
                    queryParams = emptyMap(),
                    body = bodyContent
                )

                // Update the loader message with final result
                val updatedLoaderMsg = loaderMsg.copy(
                    id = apiMessageId,
                    text = "Dynamic API executed with response code ${response.statusCode}.",
                    status = if (response.success) "SUCCESS" else "ERROR",
                    apiCallResponse = response.body,
                    apiCallStatus = response.statusCode
                )
                repository.insertMessage(updatedLoaderMsg)

                // Now use Gemini/Custom model to wrap this response in a friendly conversation summary
                val systemPrompt = "You are a professional full-stack API Assistant AI Agent. The user typed: '$text'. " +
                        "The app successfully executed the API url: $parsedUrl using $method. " +
                        "Dynamic network call response status returned ${response.statusCode}.\n" +
                        "API Payload: \n${response.body}\n" +
                        "Analyze this payload. Explaining clearly in friendly human words what was returned. " +
                        "Highlight key metrics, configuration data, or information nicely formatted in markdown. " +
                        "Provide responsive layout summaries."

                finalAiResponseText = NetworkManager.generateAiContent(
                    prompt = "Explain current api response for $parsedUrl",
                    systemPrompt = systemPrompt,
                    activeModel = settings.activeModelName,
                    isCustomGeminiEnabled = settings.isCustomGeminiKeyEnabled,
                    customGeminiKey = settings.customGeminiApiKey,
                    defaultGeminiKey = getSystemDefaultGeminiKey(),
                    isCustomModelEnabled = settings.isCustomModelEnabled,
                    customEndpoint = settings.customModelEndpoint,
                    customKey = settings.customModelApiKey,
                    customModelName = settings.customModelName,
                    conversationHistory = messagesState.value
                )
            } else {
                // Simple textual dialogue
                val systemPrompt = "You are an expert AI Agent that connects to any API. " +
                        "If the user inputs a URL starting with http/https or specifies 'run [Name]', " +
                        "you will automatically parse the parameters, make a direct network call, and read the payload live! " +
                        "If the user asks to connect to a new third-party service or app (like Vercel, Firebase, Stripe, etc.), " +
                        "reply ONLY with exactly: '[TRIGGER_CONNECT: ServiceName]'. E.g. '[TRIGGER_CONNECT: Vercel]'. Do not add any other text. " +
                        "If the user asks to run a shell command or simulate terminal execution, output realistic terminal execution in a markdown log block. " +
                        "Guide users on these robust capabilities: Model settings in 'Model' tab, registering API templates in 'Connectors' tab, " +
                        "and integrations in 'Integrations' tab."

                finalAiResponseText = NetworkManager.generateAiContent(
                    prompt = text,
                    systemPrompt = systemPrompt,
                    activeModel = settings.activeModelName,
                    isCustomGeminiEnabled = settings.isCustomGeminiKeyEnabled,
                    customGeminiKey = settings.customGeminiApiKey,
                    defaultGeminiKey = getSystemDefaultGeminiKey(),
                    isCustomModelEnabled = settings.isCustomModelEnabled,
                    customEndpoint = settings.customModelEndpoint,
                    customKey = settings.customModelApiKey,
                    customModelName = settings.customModelName,
                    conversationHistory = messagesState.value
                )

                if (finalAiResponseText.contains("[TRIGGER_CONNECT:")) {
                    val regex = "\\[TRIGGER_CONNECT:\\s*(.*?)\\]".toRegex()
                    val match = regex.find(finalAiResponseText)
                    if (match != null) {
                        val service = match.groupValues[1].removeSuffix(".").trim()
                        _showConnectionPopupFor.value = service
                        finalAiResponseText = finalAiResponseText.replace(regex, "").trim()
                        if (finalAiResponseText.isBlank()) finalAiResponseText = "Bringing up connection setup for $service..."
                    }
                }
            }

            // Save AI final answer
            val aiResponseMsg = Message(text = finalAiResponseText, isUser = false)
            repository.insertMessage(aiResponseMsg)

            _isAiThinking.value = false
        }
    }

    private fun getSystemDefaultGeminiKey(): String {
        return try {
            BuildConfig.GEMINI_API_KEY
        } catch (e: Exception) {
            ""
        }
    }

    /**
     * Scans strings to check if it's pointing to any API URL or matches a saved template name.
     */
    private fun detectApiRequest(text: String): ApiExtractionResult {
        // 1. Direct templates name match
        val templates = apiTemplatesState.value
        templates.forEach { template ->
            if (text.contains(template.name, ignoreCase = true) || 
                (text.contains("run", ignoreCase = true) && text.contains(template.name.split(" ").first(), ignoreCase = true))) {
                return ApiExtractionResult(
                    isMatch = true,
                    method = template.method,
                    url = template.url,
                    body = template.bodyTemplate
                )
            }
        }

        // 2. Direct URL syntax match e.g. "https://api.coindesk.com/..."
        val trimmed = text.trim()
        val urlRegex = "(https?://[^\\s]+)"
        val pattern = Pattern.compile(urlRegex, Pattern.CASE_INSENSITIVE)
        val matcher = pattern.matcher(trimmed)

        if (matcher.find()) {
            val url = matcher.group(1)
            var method = "GET"
            if (trimmed.startsWith("POST", ignoreCase = true)) {
                method = "POST"
            } else if (trimmed.startsWith("PUT", ignoreCase = true)) {
                method = "PUT"
            } else if (trimmed.startsWith("DELETE", ignoreCase = true)) {
                method = "DELETE"
            }

            // Extract JSON body if POST/PUT
            var body: String? = null
            if (method == "POST" || method == "PUT") {
                val braceIndex = trimmed.indexOf('{')
                if (braceIndex != -1) {
                    body = trimmed.substring(braceIndex)
                }
            }
            return ApiExtractionResult(isMatch = true, method = method, url = url, body = body)
        }

        return ApiExtractionResult(isMatch = false, method = "GET", url = null, body = null)
    }

    private data class ApiExtractionResult(
        val isMatch: Boolean,
        val method: String,
        val url: String?,
        val body: String?
    )

    private fun getHeadersForCall(url: String): Map<String, String> {
        val headers = mutableMapOf<String, String>()
        headers["Accept"] = "application/json"
        
        // Match template settings
        val matchingTemplate = apiTemplatesState.value.firstOrNull { url.contains(it.url) }
        if (matchingTemplate != null) {
            try {
                val json = JSONObject(matchingTemplate.headersJson)
                json.keys().forEach { key ->
                    headers[key] = json.getString(key)
                }
            } catch (e: Exception) {
                // ignore invalid headers JSON
            }
        }

        return headers
    }

    fun clearChat() {
        viewModelScope.launch {
            repository.clearChat()
        }
    }

    // --- Model settings modifiers ---

    fun saveServiceConnection(serviceName: String, apiKey: String) {
        viewModelScope.launch {
            val entry = com.example.data.model.ServiceConnection(
                serviceName = serviceName,
                apiKey = apiKey
            )
            repository.insertServiceConnection(entry)
        }
    }

    fun deleteServiceConnection(connection: com.example.data.model.ServiceConnection) {
        viewModelScope.launch {
            repository.deleteServiceConnection(connection)
        }
    }

    fun clearConnectionPopup() {
        _showConnectionPopupFor.value = null
    }

    fun updateModelName(modelName: String) {
        viewModelScope.launch {
            val current = settingsState.value
            repository.updateSettings(current.copy(activeModelName = modelName))
        }
    }

    fun updateCustomGeminiKey(enabled: Boolean, key: String) {
        viewModelScope.launch {
            val current = settingsState.value
            repository.updateSettings(
                current.copy(
                    isCustomGeminiKeyEnabled = enabled,
                    customGeminiApiKey = key
                )
            )
        }
    }

    fun updateCustomModel(endpoint: String, key: String, modelName: String, enabled: Boolean) {
        viewModelScope.launch {
            val current = settingsState.value
            repository.updateSettings(
                current.copy(
                    isCustomModelEnabled = enabled,
                    customModelEndpoint = endpoint,
                    customModelApiKey = key,
                    customModelName = modelName
                )
            )
        }
    }

    fun testAiModelConnection() {
        viewModelScope.launch {
            _modelTestResult.value = null
            val current = settingsState.value
            val isCustom = current.isCustomModelEnabled

            val resultMsg = if (isCustom) {
                "Testing Custom Endpoint payload flow matching ${current.customModelEndpoint} on model ${current.customModelName}..."
            } else {
                "Establishing REST connection to Gemini using model ${current.activeModelName}..."
            }

            _modelTestResult.value = resultMsg

            val response = NetworkManager.generateAiContent(
                prompt = "Hi, reply in exactly 4 words with success message.",
                systemPrompt = "Reply immediately and keep it 4 words.",
                activeModel = current.activeModelName,
                isCustomGeminiEnabled = current.isCustomGeminiKeyEnabled,
                customGeminiKey = current.customGeminiApiKey,
                defaultGeminiKey = getSystemDefaultGeminiKey(),
                isCustomModelEnabled = current.isCustomModelEnabled,
                customEndpoint = current.customModelEndpoint,
                customKey = current.customModelApiKey,
                customModelName = current.customModelName
            )
            
            _modelTestResult.value = if (response.startsWith("Error")) {
                "Connection failed: $response"
            } else {
                "Connection Success! Responder: \"$response\""
            }
        }
    }

    // --- Connectors actions ---

    fun addNewConnector(template: ApiTemplate) {
        viewModelScope.launch {
            repository.insertApiTemplate(template)
        }
    }

    fun deleteConnector(template: ApiTemplate) {
        viewModelScope.launch {
            repository.deleteApiTemplate(template)
        }
    }

    fun resetConnectorsToDefault() {
        viewModelScope.launch {
            repository.clearApiTemplates()
            repository.seedDefaultConnectors()
        }
    }

    // --- GitHub integrations actions ---

    fun connectGitHubAccount(token: String) {
        viewModelScope.launch {
            _isGitHubLoading.value = true
            _githubProfileError.value = null

            val formattedToken = token.trim()
            if (formattedToken.isBlank()) {
                _githubProfileError.value = "Personal Access Token cannot be empty."
                _isGitHubLoading.value = false
                return@launch
            }

            // Real call to GitHub API
            val profile = NetworkManager.fetchGitHubProfile(formattedToken)
            if (profile.success) {
                // Update settings
                val current = settingsState.value
                repository.updateSettings(
                    current.copy(
                        gitHubToken = formattedToken,
                        gitHubUsername = profile.username,
                        gitHubAvatarUrl = profile.avatarUrl,
                        isGitHubConnected = true
                    )
                )
                refreshGitHubData(formattedToken)
            } else {
                _githubProfileError.value = profile.error ?: "Failed to connect. Check token scope & network."
            }

            _isGitHubLoading.value = false
        }
    }

    fun exchangeGitHubCodeForToken(code: String, clientId: String, clientSecret: String) {
        viewModelScope.launch {
            _isGitHubLoading.value = true
            _githubProfileError.value = null

            val tokenResult = NetworkManager.exchangeGitHubCode(code, clientId, clientSecret)
            if (tokenResult.success && tokenResult.token != null) {
                 connectGitHubAccount(tokenResult.token)
            } else {
                 _githubProfileError.value = tokenResult.error ?: "Failed to exchange OAuth code."
                 _isGitHubLoading.value = false
            }
        }
    }

    fun connectGitHubAccountSimulated() {
        viewModelScope.launch {
            _isGitHubLoading.value = true
            _githubProfileError.value = null

            val current = settingsState.value
            repository.updateSettings(
                current.copy(
                    gitHubToken = "simulated_token_playground",
                    gitHubUsername = "OctocatDeveloper",
                    gitHubAvatarUrl = "https://avatars.githubusercontent.com/u/5832347?v=4",
                    isGitHubConnected = true
                )
            )

            // Seed simulated repos in visual state
            _gitHubRepos.value = listOf(
                NetworkManager.GitHubRepo(
                    name = "omni-api-integrator",
                    fullName = "octocat/omni-api-integrator",
                    description = "Dynamic AI assistant to proxy and analyze generic API calls automatically",
                    stars = 42,
                    language = "Kotlin",
                    htmlUrl = "https://github.com/octocat/omni-api-integrator"
                ),
                NetworkManager.GitHubRepo(
                    name = "gemini-m3-composed",
                    fullName = "octocat/gemini-m3-composed",
                    description = "A gorgeous material-3 UI playground for multi-modal Gemini triggers",
                    stars = 129,
                    language = "Kotlin",
                    htmlUrl = "https://github.com/octocat/gemini-m3-composed"
                ),
                NetworkManager.GitHubRepo(
                    name = "awesome-public-apis",
                    fullName = "octocat/awesome-public-apis",
                    description = "A collection of 30+ completely free and public testing JSON APIs for mock sandboxes",
                    stars = 3120,
                    language = "Markdown",
                    htmlUrl = "https://github.com/octocat/awesome-public-apis"
                )
            )

            _isGitHubLoading.value = false
        }
    }

    fun disconnectGitHubAccount() {
        viewModelScope.launch {
            val current = settingsState.value
            repository.updateSettings(
                current.copy(
                    gitHubToken = "",
                    gitHubUsername = "",
                    gitHubAvatarUrl = "",
                    isGitHubConnected = false
                )
            )
            _gitHubRepos.value = emptyList()
            _githubProfileError.value = null
        }
    }

    private suspend fun refreshGitHubData(token: String) {
        if (token.startsWith("simulated_")) return
        _gitHubRepos.value = NetworkManager.fetchGitHubRepos(token)
    }

    fun clearImportStatus() {
        _importStatus.value = null
    }

    fun importConfigFromRepo(repoFullName: String) {
        viewModelScope.launch {
            _importStatus.value = "Scanning $repoFullName for configurations..."
            val token = settingsState.value.gitHubToken
            // For simplicity, we assume we check the root for "api-template.json"
            val fileContent = NetworkManager.fetchGitHubFileContent(token, repoFullName, "api-template.json")
            if (fileContent != null) {
                try {
                    val jsonObj = org.json.JSONObject(fileContent)
                    val newTemplate = ApiTemplate(
                        name = jsonObj.optString("name", "Imported API"),
                        url = jsonObj.optString("url", ""),
                        method = jsonObj.optString("method", "GET"),
                        headersJson = jsonObj.optString("headersJson", "{}"),
                        bodyTemplate = jsonObj.optString("bodyTemplate", ""),
                        description = jsonObj.optString("description", "Imported from GitHub")
                    )
                    addNewConnector(newTemplate)
                    _importStatus.value = "Successfully imported configuration from $repoFullName!"
                } catch (e: Exception) {
                     _importStatus.value = "Found api-template.json but failed to parse JSON in $repoFullName."
                }
            } else {
                _importStatus.value = "No api-template.json found in the root of $repoFullName."
            }
        }
    }
}
