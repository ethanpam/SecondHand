package com.ethanpam.secondhand.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

private val LightColors = lightColorScheme(
    primary = Color(0xFF2C6452), onPrimary = Color.White,
    primaryContainer = Color(0xFFE0EDDF), onPrimaryContainer = Color(0xFF213F37),
    secondary = Color(0xFF536B5B), onSecondary = Color.White,
    secondaryContainer = Color(0xFFDDE9DD), onSecondaryContainer = Color(0xFF213F37),
    tertiary = Color(0xFF536D48), onTertiary = Color.White,
    tertiaryContainer = Color(0xFFE2EAD6), onTertiaryContainer = Color(0xFF263E27),
    surfaceTint = Color(0xFF2C6452), inversePrimary = Color(0xFFA2D3B9),
    background = Color(0xFFF7F5ED), onBackground = Color(0xFF213F37),
    surface = Color(0xFFFFFEFA), onSurface = Color(0xFF213F37),
    surfaceVariant = Color(0xFFEAEDE4), onSurfaceVariant = Color(0xFF607068),
    outline = Color(0xFF82968A), outlineVariant = Color(0xFFD8E0D5)
)
private val DarkColors = darkColorScheme(
    primary = Color(0xFF8CCCB1), onPrimary = Color(0xFF183D2E),
    primaryContainer = Color(0xFF254D3E), onPrimaryContainer = Color(0xFFE0EEDF),
    secondary = Color(0xFFBDD1C0), onSecondary = Color(0xFF283E31),
    secondaryContainer = Color(0xFF385243), onSecondaryContainer = Color(0xFFDAEADF),
    tertiary = Color(0xFFC5D5AC), onTertiary = Color(0xFF304122),
    tertiaryContainer = Color(0xFF455735), onTertiaryContainer = Color(0xFFE1EDCB),
    surfaceTint = Color(0xFF8CCCB1), inversePrimary = Color(0xFF2C6452),
    background = Color(0xFF101B17), onBackground = Color(0xFFE1F0E7),
    surface = Color(0xFF1B2923), onSurface = Color(0xFFE1F0E7),
    surfaceVariant = Color(0xFF293B31), onSurfaceVariant = Color(0xFFB8C9BD),
    outline = Color(0xFF7E9B8A), outlineVariant = Color(0xFF3C5145)
)

internal object AppPalette {
    val ForestStart = Color(0xFF2B5C4A)
    val ForestEnd = Color(0xFF1A423B)
    val Mint = Color(0xFFE8F2E0)
    val ForestInk = Color(0xFF214A3D)
}

@Composable
fun SecondHandTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        shapes = Shapes(small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(18.dp), large = RoundedCornerShape(24.dp)),
        content = content)
}

@Composable
internal fun AppCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth(), shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp), content = content)
    }
}

@Composable
internal fun SectionTitle(title: String, subtitle: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun IconBadge(icon: ImageVector) {
    Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(15.dp)) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(12.dp).size(24.dp))
    }
}

@Composable
internal fun PrimaryButton(text: String, onClick: () -> Unit, enabled: Boolean = true, icon: ImageVector? = null,
    colors: ButtonColors = ButtonDefaults.buttonColors()) {
    Button(onClick = onClick, enabled = enabled, colors = colors, shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), contentPadding = PaddingValues(14.dp)) {
        if (icon != null) { Icon(icon, null, Modifier.size(20.dp)); Spacer(Modifier.width(9.dp)) }
        Text(text, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun StorageNote() {
    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Rounded.Lock, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(7.dp))
        Text("Saved on this phone", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun DetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value.ifBlank { "Not added" }, Modifier.weight(1.2f), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
internal fun ErrorDialog(message: String?, onDismiss: () -> Unit) {
    if (message != null) AlertDialog(onDismissRequest = onDismiss, title = { Text("Couldn’t complete that action") },
        text = { Text(message) }, confirmButton = { TextButton(onClick = onDismiss) { Text("OK") } })
}
