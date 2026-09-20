package io.github.takkunlego0916.playpocket

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.DocumentsContract
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.io.BufferedOutputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap

class MainActivity : AppCompatActivity() {
    private lateinit var container: FrameLayout
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var notificationControlsEnabled = false
    private var isPlayingState = false
    private var lastTrackTitle = ""
    private var isDebuggableBuild = false
    private val renderRecoveries = ArrayDeque<Long>()

    private class SaveSession(val id: String, val fileName: String, val mimeType: String) {
        @Volatile var uri: Uri? = null
        @Volatile var stream: OutputStream? = null
    }

    private val saveSessions = ConcurrentHashMap<String, SaveSession>()

    @Volatile
    private var pendingSaveId: String? = null

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private fun startUrl(): String {
        val base = "file:///android_asset/index.html"
        return if (isDebuggableBuild) "$base?dev=1" else base
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun dispatchPlaybackCommand(command: String) {
        if (!::webView.isInitialized) return
        val safeCommand = when (command) {
            "previous-track", "toggle-play-pause", "next-track" -> command
            else -> return
        }
        webView.evaluateJavascript(
            "window.__ppHandlePlaybackCommand && window.__ppHandlePlaybackCommand('$safeCommand');",
            null
        )
    }

    private fun isOfficialSite(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        val host = uri.host?.lowercase() ?: return false
        return scheme == "https" && host == "playpocket.f5.si" && uri.userInfo == null && uri.port == -1
    }

    private fun sanitizeFileName(value: String?): String {
        val cleaned = value.orEmpty()
            .replace(Regex("[\\u0000-\\u001F\\u007F<>:\"/\\\\|?*]"), "-")
            .trim()
            .trimEnd('.', ' ')
            .take(120)
        return if (cleaned.isEmpty()) "playpocket-export.json" else cleaned
    }

    private fun sanitizeMimeType(value: String?): String {
        val text = value.orEmpty().trim()
        return if (Regex("^[A-Za-z0-9.+-]{1,60}/[A-Za-z0-9.+-]{1,60}$").matches(text)) text else "application/octet-stream"
    }

    private fun notifySaveReady(id: String, ok: Boolean) {
        runOnUiThread {
            if (!::webView.isInitialized) return@runOnUiThread
            webView.evaluateJavascript(
                "window.__ppOnSaveReady && window.__ppOnSaveReady('$id', $ok);",
                null
            )
        }
    }

    private fun closeSaveSession(session: SaveSession, deleteFile: Boolean) {
        saveSessions.remove(session.id)
        try {
            session.stream?.close()
        } catch (e: Exception) {
            Log.w(TAG, "close save stream failed", e)
        }
        session.stream = null
        val uri = session.uri
        if (deleteFile && uri != null) {
            try {
                DocumentsContract.deleteDocument(contentResolver, uri)
            } catch (e: Exception) {
                Log.w(TAG, "delete partial save failed", e)
            }
        }
    }

    private fun abortAllSaves() {
        pendingSaveId = null
        for (session in saveSessions.values.toList()) {
            closeSaveSession(session, deleteFile = true)
        }
    }

    private val createDocumentLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val id = pendingSaveId ?: return@registerForActivityResult
            pendingSaveId = null
            val session = saveSessions[id] ?: return@registerForActivityResult
            val uri = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
            if (uri == null) {
                saveSessions.remove(id)
                notifySaveReady(id, false)
                return@registerForActivityResult
            }
            try {
                val output = contentResolver.openOutputStream(uri, "w")
                    ?: throw java.io.IOException("openOutputStream returned null")
                session.uri = uri
                session.stream = BufferedOutputStream(output, 64 * 1024)
                notifySaveReady(id, true)
            } catch (e: Exception) {
                Log.w(TAG, "open save target failed", e)
                closeSaveSession(session, deleteFile = true)
                notifySaveReady(id, false)
            }
        }

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = filePathCallback ?: return@registerForActivityResult
            filePathCallback = null

            if (result.resultCode != Activity.RESULT_OK) {
                callback.onReceiveValue(null)
                return@registerForActivityResult
            }

            val data = result.data
            val uris = mutableListOf<Uri>()

            val clip = data?.clipData
            if (clip != null) {
                for (i in 0 until clip.itemCount) {
                    clip.getItemAt(i)?.uri?.let { uris.add(it) }
                }
            } else {
                data?.data?.let { uris.add(it) }
            }

            callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
        }

    inner class JsBridge {
        @JavascriptInterface
        fun setNotificationControlsEnabled(enabled: Boolean) {
            runOnUiThread {
                notificationControlsEnabled = enabled
                if (enabled) {
                    ensureNotificationPermission()
                    PlaybackNotificationService.updateState(this@MainActivity, isPlayingState, lastTrackTitle)
                } else {
                    PlaybackNotificationService.stop(this@MainActivity)
                }
            }
        }

        @JavascriptInterface
        fun updatePlaybackState(isPlaying: Boolean, title: String?) {
            val safeTitle = title.orEmpty().replace(Regex("[\\u0000-\\u001F\\u007F]"), "").take(200)
            runOnUiThread {
                isPlayingState = isPlaying
                lastTrackTitle = safeTitle
                if (notificationControlsEnabled) {
                    PlaybackNotificationService.updateState(this@MainActivity, isPlaying, safeTitle)
                }
            }
        }

        @JavascriptInterface
        fun clearCache() {
            runOnUiThread {
                if (::webView.isInitialized) webView.clearCache(true)
            }
        }

        @JavascriptInterface
        fun openExternal(url: String?) {
            val safeUrl = url?.trim().orEmpty()
            if (safeUrl.isEmpty() || safeUrl.length > 2048) return

            val uri = try {
                Uri.parse(safeUrl)
            } catch (e: Exception) {
                return
            }

            if (isOfficialSite(uri)) {
                runOnUiThread {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                    } catch (e: Exception) {
                        Log.w(TAG, "open external failed", e)
                    }
                }
            }
        }

        @JavascriptInterface
        fun beginSave(requestId: String?, fileName: String?, mimeType: String?, totalBytes: Double): Boolean {
            val id = requestId.orEmpty()
            if (!Regex("^[A-Za-z0-9_-]{1,64}$").matches(id)) return false
            if (pendingSaveId != null || saveSessions.isNotEmpty()) return false
            if (totalBytes.isNaN() || totalBytes < 0) return false

            val session = SaveSession(id, sanitizeFileName(fileName), sanitizeMimeType(mimeType))
            saveSessions[id] = session
            pendingSaveId = id

            runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = session.mimeType
                        putExtra(Intent.EXTRA_TITLE, session.fileName)
                    }
                    createDocumentLauncher.launch(intent)
                } catch (e: Exception) {
                    Log.w(TAG, "launch save picker failed", e)
                    pendingSaveId = null
                    saveSessions.remove(id)
                    notifySaveReady(id, false)
                }
            }
            return true
        }

        @JavascriptInterface
        fun writeSaveChunk(saveId: String?, base64: String?): Boolean {
            val session = saveSessions[saveId.orEmpty()] ?: return false
            val stream = session.stream ?: return false
            if (base64.isNullOrEmpty()) return true
            return try {
                stream.write(Base64.decode(base64, Base64.DEFAULT))
                true
            } catch (e: Exception) {
                Log.w(TAG, "write save chunk failed", e)
                closeSaveSession(session, deleteFile = true)
                false
            }
        }

        @JavascriptInterface
        fun finishSave(saveId: String?): Boolean {
            val session = saveSessions[saveId.orEmpty()] ?: return false
            val stream = session.stream ?: return false
            return try {
                stream.flush()
                stream.close()
                session.stream = null
                saveSessions.remove(session.id)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, R.string.save_success, Toast.LENGTH_SHORT).show()
                }
                true
            } catch (e: Exception) {
                Log.w(TAG, "finish save failed", e)
                closeSaveSession(session, deleteFile = true)
                runOnUiThread {
                    Toast.makeText(this@MainActivity, R.string.save_failed, Toast.LENGTH_LONG).show()
                }
                false
            }
        }

        @JavascriptInterface
        fun cancelSave(saveId: String?) {
            val session = saveSessions[saveId.orEmpty()] ?: return
            closeSaveSession(session, deleteFile = true)
            runOnUiThread {
                Toast.makeText(this@MainActivity, R.string.save_failed, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun closeOpenPanelsIfAny(onResult: (Boolean) -> Unit) {
        val script = """
            (function () {
              try {
                if (window.__ppClosePanels && window.__ppClosePanels()) {
                  return '1';
                }
                return '0';
              } catch (e) {
                return '0';
              }
            })();
        """.trimIndent()

        webView.evaluateJavascript(script) { result ->
            val handled = result?.trim()?.trim('"') == "1"
            onResult(handled)
        }
    }

    private fun createWebView(): WebView {
        val view = WebView(this)
        view.setBackgroundColor(Color.parseColor("#121212"))

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false

            allowFileAccess = true
            allowContentAccess = true
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false

            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            setGeolocationEnabled(false)
            saveFormData = false
            @Suppress("DEPRECATION")
            savePassword = false

            userAgentString = userAgentString + " PlayPocketAndroid"
        }

        view.addJavascriptInterface(JsBridge(), "AndroidBridge")

        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val uri = request.url ?: return true
                val url = uri.toString()

                return when {
                    url.startsWith("file://") -> false
                    url.startsWith("blob:") -> false
                    url.startsWith("data:") -> false
                    isOfficialSite(uri) -> {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, uri))
                        } catch (e: Exception) {
                            Log.w(TAG, "open official site failed", e)
                        }
                        true
                    }
                    else -> true
                }
            }

            @RequiresApi(Build.VERSION_CODES.O)
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "WebView render process gone (crashed=${detail.didCrash()})")
                handleRenderProcessGone(view)
                return true
            }
        }

        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback

                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"

                    val acceptTypes = fileChooserParams.acceptTypes
                        ?.filter { it.isNotBlank() }
                        ?.toTypedArray()

                    if (!acceptTypes.isNullOrEmpty()) {
                        putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes)
                    }

                    putExtra(
                        Intent.EXTRA_ALLOW_MULTIPLE,
                        fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                    )
                }

                return try {
                    fileChooserLauncher.launch(Intent.createChooser(intent, "ファイルを選択"))
                    true
                } catch (e: Exception) {
                    Log.w(TAG, "launch file chooser failed", e)
                    this@MainActivity.filePathCallback = null
                    filePathCallback.onReceiveValue(null)
                    false
                }
            }
        }

        return view
    }

    private fun handleRenderProcessGone(deadView: WebView) {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread

            val now = SystemClock.elapsedRealtime()
            while (renderRecoveries.isNotEmpty() && now - renderRecoveries.first() > RENDER_RECOVERY_WINDOW_MS) {
                renderRecoveries.removeFirst()
            }
            renderRecoveries.addLast(now)

            isPlayingState = false
            PlaybackNotificationService.stop(this)
            filePathCallback?.onReceiveValue(null)
            filePathCallback = null
            abortAllSaves()

            container.removeView(deadView)
            deadView.destroy()

            if (renderRecoveries.size > MAX_RENDER_RECOVERIES) {
                Toast.makeText(this, R.string.webview_crash_repeated, Toast.LENGTH_LONG).show()
                finish()
                return@runOnUiThread
            }

            webView = createWebView()
            container.addView(
                webView,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            )
            webView.loadUrl(startUrl())
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        isDebuggableBuild = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(isDebuggableBuild)

        container = FrameLayout(this)
        container.setBackgroundColor(Color.parseColor("#121212"))
        setContentView(container)

        webView = createWebView()
        container.addView(
            webView,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )

        PlaybackNotificationService.commandListener = { command ->
            runOnUiThread { dispatchPlaybackCommand(command) }
        }

        val restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null
        if (!restored) {
            webView.loadUrl(startUrl())
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!::webView.isInitialized) {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    return
                }

                closeOpenPanelsIfAny { handled ->
                    if (handled) return@closeOpenPanelsIfAny

                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::webView.isInitialized) {
            webView.saveState(outState)
        }
    }

    override fun onPause() {
        super.onPause()
        if (::webView.isInitialized) {
            val keepRunningInBackground = notificationControlsEnabled && isPlayingState
            if (!keepRunningInBackground) {
                webView.onPause()
                webView.pauseTimers()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.onResume()
            webView.resumeTimers()
        }
    }

    override fun onDestroy() {
        PlaybackNotificationService.commandListener = null
        PlaybackNotificationService.stop(this)
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        abortAllSaves()
        if (::webView.isInitialized) {
            webView.stopLoading()
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.removeAllViews()
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "PlayPocket"
        private const val MAX_RENDER_RECOVERIES = 3
        private const val RENDER_RECOVERY_WINDOW_MS = 60_000L
    }
}
