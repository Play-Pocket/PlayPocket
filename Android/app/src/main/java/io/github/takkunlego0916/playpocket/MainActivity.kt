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
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var notificationControlsEnabled = false
    private var isPlayingState = false
    private var lastTrackTitle = ""

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

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

            if (data?.clipData != null) {
                val clip = data.clipData!!
                for (i in 0 until clip.itemCount) {
                    uris.add(clip.getItemAt(i).uri)
                }
            } else if (data?.data != null) {
                uris.add(data.data!!)
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
            runOnUiThread {
                isPlayingState = isPlaying
                lastTrackTitle = title.orEmpty()
                if (notificationControlsEnabled) {
                    PlaybackNotificationService.updateState(this@MainActivity, isPlaying, lastTrackTitle)
                }
            }
        }

        @JavascriptInterface
        fun clearCache() {
            runOnUiThread {
                webView.clearCache(true)
            }
        }

        @JavascriptInterface
        fun openExternal(url: String?) {
            val safeUrl = url?.trim().orEmpty()
            if (safeUrl.isEmpty()) return

            val uri = try {
                Uri.parse(safeUrl)
            } catch (e: Exception) {
                return
            }

            val scheme = uri.scheme?.lowercase() ?: return
            val host = uri.host?.lowercase() ?: return
            val isOfficialSite = scheme == "https" && host == "playpocket.f5.si" && uri.userInfo == null
            if (isOfficialSite) {
                val intent = Intent(Intent.ACTION_VIEW, uri)
                if (intent.resolveActivity(packageManager) != null) {
                    startActivity(intent)
                }
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)

        webView.setBackgroundColor(Color.parseColor("#121212"))

        setContentView(webView)

        val isDebuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(isDebuggable)

        webView.settings.apply {
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
            saveFormData = false
            @Suppress("DEPRECATION")
            savePassword = false

            userAgentString = userAgentString + " PlayPocketAndroid"
        }

        webView.addJavascriptInterface(JsBridge(), "AndroidBridge")

        PlaybackNotificationService.commandListener = { command ->
            runOnUiThread { dispatchPlaybackCommand(command) }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url?.toString() ?: return true

                return when {
                    url.startsWith("file://") -> false
                    url.startsWith("blob:") -> false
                    url.startsWith("data:") -> false
                    url.startsWith("http://") || url.startsWith("https://") -> {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        if (intent.resolveActivity(packageManager) != null) {
                            startActivity(intent)
                        }
                        true
                    }
                    else -> true
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
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

                fileChooserLauncher.launch(Intent.createChooser(intent, "ファイルを選択"))
                return true
            }
        }

        if (savedInstanceState == null) {
            webView.loadUrl("file:///android_asset/index.html")
        } else {
            webView.restoreState(savedInstanceState)
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
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }
}
