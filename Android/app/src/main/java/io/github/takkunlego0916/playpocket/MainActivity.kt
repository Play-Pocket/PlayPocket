package io.github.takkunlego0916.playpocket

import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled  = true
            domStorageEnabled  = true

            allowFileAccess                 = false
            allowContentAccess              = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs     = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false

            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

            setSupportZoom(false)
            builtInZoomControls  = false
            displayZoomControls  = false
            saveFormData         = false
            @Suppress("DEPRECATION")
            savePassword         = false
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url?.toString() ?: return true
                return when {
                    url.startsWith("file://") -> false
                    url.startsWith("blob:")   -> false
                    else                      -> true
                }
            }
        }

        webView.loadUrl("file:///android_asset/index.html")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }
}
