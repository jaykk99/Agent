package com.example.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val DarkColorScheme =
  darkColorScheme(
      primary = CyberCyan,
      onPrimary = Color.Black,
      secondary = CyberIndigo,
      onSecondary = Color.White,
      tertiary = CyberPink,
      background = DarkBackground,
      surface = DarkSurface,
      surfaceVariant = DarkSurfaceVariant,
      onBackground = Color.White,
      onSurface = Color.White,
      onSurfaceVariant = Color(0xFF9CA3AF)
  )

private val LightColorScheme =
  lightColorScheme(
      primary = LightCyan,
      onPrimary = Color.White,
      secondary = LightIndigo,
      onSecondary = Color.White,
      tertiary = CyberPink,
      background = LightBackground,
      surface = LightSurface,
      surfaceVariant = LightSurfaceVariant,
      onBackground = Color(0xFF111827),
      onSurface = Color(0xFF111827),
      onSurfaceVariant = Color(0xFF4B5563)
  )

@Composable
fun MyApplicationTheme(
  darkTheme: Boolean = isSystemInDarkTheme(),
  // Disable dynamic color to enforce our cyber branding
  dynamicColor: Boolean = false,
  content: @Composable () -> Unit,
) {
  val colorScheme =
    when {
      dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
        val context = LocalContext.current
        if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
      }

      darkTheme -> DarkColorScheme
      else -> LightColorScheme
    }

  MaterialTheme(colorScheme = colorScheme, typography = Typography, content = content)
}
