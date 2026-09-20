package io.github.takkunlego0916.playpocket

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle

class PlaybackNotificationService : Service() {

    companion object {
        private const val TAG = "PlayPocketService"
        private const val CHANNEL_ID = "playpocket_playback"
        private const val NOTIFICATION_ID = 4201
        private const val WAKE_LOCK_TIMEOUT_MS = 6L * 60L * 60L * 1000L

        private const val ACTION_PREVIOUS = "io.github.takkunlego0916.playpocket.ACTION_PREVIOUS"
        private const val ACTION_TOGGLE = "io.github.takkunlego0916.playpocket.ACTION_TOGGLE"
        private const val ACTION_NEXT = "io.github.takkunlego0916.playpocket.ACTION_NEXT"
        private const val ACTION_UPDATE = "io.github.takkunlego0916.playpocket.ACTION_UPDATE"
        private const val ACTION_STOP = "io.github.takkunlego0916.playpocket.ACTION_STOP"

        private const val EXTRA_IS_PLAYING = "extra_is_playing"
        private const val EXTRA_TITLE = "extra_title"

        var commandListener: ((String) -> Unit)? = null

        fun updateState(context: Context, isPlaying: Boolean, title: String) {
            val intent = Intent(context, PlaybackNotificationService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_IS_PLAYING, isPlaying)
                putExtra(EXTRA_TITLE, title)
            }
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (e: IllegalStateException) {
                Log.w(TAG, "foreground service start was not allowed", e)
            } catch (e: SecurityException) {
                Log.w(TAG, "foreground service start was denied", e)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, PlaybackNotificationService::class.java).apply {
                action = ACTION_STOP
            }
            try {
                context.startService(intent)
            } catch (e: IllegalStateException) {
                Log.w(TAG, "startService(STOP) was not allowed, falling back to stopService", e)
                try {
                    context.stopService(Intent(context, PlaybackNotificationService::class.java))
                } catch (inner: Exception) {
                    Log.w(TAG, "stopService failed", inner)
                }
            } catch (e: Exception) {
                Log.w(TAG, "stop failed", e)
            }
        }
    }

    private var mediaSession: MediaSessionCompat? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var isPlaying = false
    private var trackTitle: String = ""

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        ensureMediaSession()
    }

    private fun ensureMediaSession(): MediaSessionCompat {
        mediaSession?.let { return it }
        val session = MediaSessionCompat(this, "PlayPocketPlaybackSession").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() {
                    if (!isPlaying) commandListener?.invoke("toggle-play-pause")
                }

                override fun onPause() {
                    if (isPlaying) commandListener?.invoke("toggle-play-pause")
                }

                override fun onSkipToPrevious() { commandListener?.invoke("previous-track") }
                override fun onSkipToNext() { commandListener?.invoke("next-track") }
            })
            isActive = true
        }
        mediaSession = session
        return session
    }

    private fun ensureChannel() {
        val channel = NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_LOW)
            .setName(getString(R.string.notification_channel_playback_name))
            .setDescription(getString(R.string.notification_channel_playback_description))
            .setShowBadge(false)
            .build()
        NotificationManagerCompat.from(this).createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PREVIOUS -> commandListener?.invoke("previous-track")
            ACTION_TOGGLE -> commandListener?.invoke("toggle-play-pause")
            ACTION_NEXT -> commandListener?.invoke("next-track")
            ACTION_STOP -> {
                stopPlaybackForeground()
                stopSelf()
            }
            ACTION_UPDATE -> {
                isPlaying = intent.getBooleanExtra(EXTRA_IS_PLAYING, false)
                trackTitle = intent.getStringExtra(EXTRA_TITLE).orEmpty()
                publishState()
            }
        }
        return START_NOT_STICKY
    }

    private fun stopPlaybackForeground() {
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (e: Exception) {
            Log.w(TAG, "stopForeground failed", e)
        }
        updateWakeLock(false)
    }

    private fun publishState() {
        val session = ensureMediaSession()

        val state = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or
                    PlaybackStateCompat.ACTION_PAUSE or
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            )
            .setState(
                if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
                1f
            )
            .build()
        session.setPlaybackState(state)

        val metadata = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, trackTitle.ifBlank { getString(R.string.app_name) })
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, getString(R.string.app_name))
            .build()
        session.setMetadata(metadata)

        try {
            startForeground(NOTIFICATION_ID, buildNotification(session))
        } catch (e: IllegalStateException) {
            Log.w(TAG, "startForeground was not allowed", e)
            stopSelf()
            return
        } catch (e: SecurityException) {
            Log.w(TAG, "startForeground was denied", e)
            stopSelf()
            return
        }
        updateWakeLock(isPlaying)
    }

    private fun actionPendingIntent(action: String): PendingIntent {
        val intent = Intent(this, PlaybackNotificationService::class.java).apply { this.action = action }
        return PendingIntent.getService(
            this,
            action.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildNotification(session: MediaSessionCompat): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playPauseIcon = if (isPlaying) R.drawable.ic_action_pause else R.drawable.ic_action_play
        val playPauseLabel = if (isPlaying) {
            getString(R.string.notification_action_pause)
        } else {
            getString(R.string.notification_action_play)
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(trackTitle.ifBlank { getString(R.string.app_name) })
            .setContentText(getString(R.string.app_name))
            .setContentIntent(contentIntent)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(R.drawable.ic_action_previous, getString(R.string.notification_action_previous), actionPendingIntent(ACTION_PREVIOUS))
            .addAction(playPauseIcon, playPauseLabel, actionPendingIntent(ACTION_TOGGLE))
            .addAction(R.drawable.ic_action_next, getString(R.string.notification_action_next), actionPendingIntent(ACTION_NEXT))
            .setStyle(
                MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .build()
    }

    private fun updateWakeLock(shouldHold: Boolean) {
        try {
            if (shouldHold) {
                if (wakeLock == null) {
                    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PlayPocket:PlaybackWakeLock").apply {
                        setReferenceCounted(false)
                    }
                }
                wakeLock?.acquire(WAKE_LOCK_TIMEOUT_MS)
            } else if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (e: Exception) {
            Log.w(TAG, "wake lock update failed", e)
        }
    }

    override fun onDestroy() {
        updateWakeLock(false)
        mediaSession?.isActive = false
        mediaSession?.release()
        mediaSession = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
