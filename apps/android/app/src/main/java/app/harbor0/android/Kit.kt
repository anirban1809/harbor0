package app.harbor0.android

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog

// The Android counterpart of apps/web/components/theme: one set of heights, radii, borders and tones for every screen.
// Controls are taller than on the web (44dp, 36dp small) and keep 48dp touch targets.

/** Paints a surface and re-derives the tokens used inside it. */
@Composable fun Sheet(color: Color, modifier: Modifier = Modifier, shape: Shape = RectangleShape, border: Boolean = false, content: @Composable () -> Unit) {
    val line = theme.line
    OnSurface(color, modifier.clip(shape).then(if (border) Modifier.border(1.dp, line, shape) else Modifier), content = content)
}
@Composable fun Card(modifier: Modifier = Modifier, padding: Dp = 16.dp, content: @Composable ColumnScope.() -> Unit) {
    Sheet(theme.palette.card, modifier.fillMaxWidth(), RoundedCornerShape(Radius.lg), border = true) {
        Column(Modifier.fillMaxWidth().padding(padding), content = content)
    }
}
@Composable fun CardHeader(title: String, description: String? = null) {
    Column(Modifier.padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = Type.h2, modifier = Modifier.semantics { heading() })
        description?.let { Text(it, style = Type.sm, color = theme.text2) }
    }
}
@Composable fun Divider(modifier: Modifier = Modifier) = Box(modifier.fillMaxWidth().height(1.dp).background(theme.line))

enum class Variant { Primary, Outline, Ghost, Danger, DangerGhost, Link }
@Composable fun HButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, variant: Variant = Variant.Primary,
    enabled: Boolean = true, small: Boolean = false, icon: ImageVector? = null) {
    val t = theme
    val shape = RoundedCornerShape(if (variant == Variant.Link) 4.dp else Radius.md)
    val (fill, ink) = when (variant) {
        Variant.Primary -> t.primary to t.onPrimary
        Variant.Danger -> t.palette.destructive to t.palette.onDestructive
        Variant.Outline -> t.surface to t.text
        Variant.Ghost -> Color.Transparent to t.text2
        Variant.DangerGhost -> Color.Transparent to t.dangerText
        Variant.Link -> Color.Transparent to t.accentText
    }
    val link = variant == Variant.Link
    Row(modifier.then(if (small || link) Modifier.minimumInteractiveComponentSize() else Modifier).alpha(if (enabled) 1f else .5f)
        .defaultMinSize(minHeight = if (link) 0.dp else if (small) 36.dp else 44.dp).clip(shape).background(fill)
        .then(if (variant == Variant.Outline) Modifier.border(1.dp, t.line, shape) else Modifier)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .padding(horizontal = if (link) 2.dp else if (small) 12.dp else 16.dp, vertical = if (link) 2.dp else 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        icon?.let { Icon(it, null, Modifier.size(16.dp), tint = ink) }
        Text(text, style = if (link) Type.sm.copy(fontWeight = Type.label.fontWeight) else Type.button, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
@Composable fun HIconButton(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, primary: Boolean = false, enabled: Boolean = true) {
    val t = theme
    val shape = RoundedCornerShape(Radius.md)
    Box(modifier.minimumInteractiveComponentSize().alpha(if (enabled) 1f else .5f).size(36.dp).clip(shape)
        .background(if (primary) t.primary else Color.Transparent)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(if (primary) 18.dp else 20.dp), tint = if (primary) t.onPrimary else t.text2)
    }
}

@Composable fun Field(label: String, modifier: Modifier = Modifier, hint: String? = null, content: @Composable () -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = Type.label)
        content()
        hint?.let { Text(it, style = Type.xs, color = theme.text2) }
    }
}
@Composable fun HInput(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier, placeholder: String = "", invalid: Boolean = false,
    style: TextStyle = Type.body, keyboardOptions: KeyboardOptions = KeyboardOptions.Default, keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None) {
    val t = theme
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(Radius.md)
    val edge = when { invalid -> t.palette.destructive; focused -> t.primary; else -> t.line }
    BasicTextField(value, onValueChange, modifier.fillMaxWidth(), textStyle = style.copy(color = t.text), singleLine = true,
        cursorBrush = SolidColor(t.primary), keyboardOptions = keyboardOptions, keyboardActions = keyboardActions,
        visualTransformation = visualTransformation, interactionSource = interaction) { inner ->
        Box(Modifier.drawBehind {
            // Focus ring: a 3dp halo outside the border, as on the web inputs.
            val ring = 3.dp.toPx()
            if (focused) drawRoundRect(edge.copy(alpha = .2f), Offset(-ring, -ring), Size(size.width + ring * 2, size.height + ring * 2), CornerRadius(Radius.md.toPx() + ring))
        }.height(44.dp).background(t.surface, shape).border(1.dp, edge, shape).padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty() && placeholder.isNotEmpty()) Text(placeholder, style = style, color = t.text3, maxLines = 1)
            inner()
        }
    }
}

@Composable fun Segmented(options: List<Pair<String, String>>, value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    val t = theme
    Row(modifier.clip(RoundedCornerShape(10.dp)).background(t.fill2).padding(3.dp).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        options.forEach { (id, label) ->
            val selected = id == value
            val shape = RoundedCornerShape(7.dp)
            Box(Modifier.weight(1f).heightIn(min = 38.dp).then(if (selected) Modifier.shadow(1.dp, shape).background(t.surface, shape).border(1.dp, t.text.copy(alpha = .08f), shape) else Modifier)
                .clip(shape).selectable(selected, role = Role.RadioButton) { onChange(id) }.padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
                Text(label, style = Type.label, color = if (selected) t.text else t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

enum class Tone { Neutral, Accent, Success, Warning, Danger }
@Composable fun Badge(text: String, tone: Tone = Tone.Neutral) {
    val t = theme
    val (fill, ink) = when (tone) {
        Tone.Neutral -> t.fill2 to t.text2
        Tone.Accent -> t.accentSoft to t.accentText
        Tone.Success -> t.successSoft to t.successText
        Tone.Warning -> t.warningSoft to t.warningText
        Tone.Danger -> t.dangerSoft to t.dangerText
    }
    Text(text, Modifier.background(fill, CircleShape).padding(horizontal = 8.dp, vertical = 2.dp), style = Type.xs.copy(fontWeight = Type.label.fontWeight), color = ink, maxLines = 1)
}
@Composable fun Alert(text: String, modifier: Modifier = Modifier, tone: Tone = Tone.Neutral, action: String? = null, onAction: () -> Unit = {}) {
    val t = theme
    val (fill, ink) = when (tone) { Tone.Danger -> t.dangerSoft to t.dangerText; Tone.Warning -> t.warningSoft to t.warningText; else -> t.fill1 to t.text }
    Row(modifier.fillMaxWidth().background(fill, RoundedCornerShape(Radius.md)).padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(if (tone == Tone.Success) Lucide.CircleCheck else Lucide.CircleAlert, null, Modifier.size(16.dp),
            tint = when (tone) { Tone.Success -> t.successText; Tone.Neutral -> t.text2; else -> ink })
        Text(text, Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 12.dp), style = Type.sm, color = ink)
        action?.let {
            Text(it, Modifier.minimumInteractiveComponentSize().clip(RoundedCornerShape(Radius.sm)).clickable(role = Role.Button, onClick = onAction).padding(8.dp),
                style = Type.label, color = ink, textDecoration = TextDecoration.Underline)
        }
    }
}

@Composable fun Progress(fraction: Float?, modifier: Modifier = Modifier, height: Dp = 6.dp) {
    val t = theme
    val slide = if (fraction == null) rememberInfiniteTransition(label = "progress").animateFloat(0f, 1f,
        infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing)), label = "slide").value else 0f
    Box(modifier.fillMaxWidth().height(height).clip(CircleShape).background(t.fill3).drawBehind {
        val radius = CornerRadius(size.height / 2)
        if (fraction == null) drawRoundRect(t.primary, Offset(size.width * (-.35f + 1.35f * slide), 0f), Size(size.width * .35f, size.height), radius)
        else drawRoundRect(t.primary, size = Size(size.width * fraction.coerceIn(0f, 1f), size.height), cornerRadius = radius)
    }.clearAndSetSemantics { })
}
@Composable fun Skeleton(modifier: Modifier = Modifier) {
    val pulse by rememberInfiniteTransition(label = "skeleton").animateFloat(1f, .45f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "pulse")
    Box(modifier.alpha(pulse).background(theme.fill2, RoundedCornerShape(Radius.sm)))
}

/** Tinted square behind an icon, as used for file kinds and empty states. */
@Composable fun IconTile(icon: ImageVector, tint: Color = theme.text2, size: Dp = 36.dp) {
    Box(Modifier.size(size).background(tint.copy(alpha = .13f), RoundedCornerShape(size / 4)), contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(size / 2), tint = tint)
    }
}
@Composable fun Avatar(name: String, size: Dp = 40.dp) {
    val initials = name.split(' ').filter { it.isNotBlank() }.take(2).joinToString("") { it.take(1).uppercase() }.ifEmpty { "?" }
    Box(Modifier.size(size).background(theme.accentSoft, CircleShape).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        Text(initials, style = Type.label.copy(fontWeight = Type.h3.fontWeight), color = theme.accentText)
    }
}
@Composable fun EmptyState(icon: ImageVector, title: String, description: String, modifier: Modifier = Modifier, compact: Boolean = false, actions: @Composable RowScope.() -> Unit = {}) {
    Column(modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = if (compact) 32.dp else 56.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Box(Modifier.size(44.dp).background(theme.fill2, RoundedCornerShape(Radius.lg)), contentAlignment = Alignment.Center) { Icon(icon, null, Modifier.size(20.dp), tint = theme.text2) }
        Column(Modifier.widthIn(max = 380.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = Type.h3, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            Text(description, style = Type.sm, color = theme.text2, textAlign = TextAlign.Center)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), content = actions)
    }
}

@Composable fun HMenu(expanded: Boolean, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val card = theme.palette.on(theme.palette.card)
    DropdownMenu(expanded, onDismiss, shape = RoundedCornerShape(10.dp), containerColor = card.surface, tonalElevation = 0.dp, shadowElevation = 10.dp,
        border = BorderStroke(1.dp, card.line)) {
        CompositionLocalProvider(LocalTokens provides card, LocalContentColor provides card.text) { content() }
    }
}
@Composable fun HMenuItem(text: String, icon: ImageVector, onClick: () -> Unit, danger: Boolean = false) {
    val ink = if (danger) theme.dangerText else theme.text
    DropdownMenuItem(text = { Text(text, style = Type.button.copy(fontWeight = Type.body.fontWeight), color = ink) }, onClick = onClick,
        leadingIcon = { Icon(icon, null, Modifier.size(16.dp), tint = if (danger) ink else theme.text2) })
}
@OptIn(ExperimentalLayoutApi::class)
@Composable fun HDialog(title: String, onDismiss: () -> Unit, description: String? = null, actions: @Composable RowScope.() -> Unit, content: (@Composable ColumnScope.() -> Unit)? = null) {
    Dialog(onDismissRequest = onDismiss) {
        val shape = RoundedCornerShape(Radius.xl)
        Sheet(theme.palette.card, Modifier.widthIn(max = 440.dp).fillMaxWidth().shadow(24.dp, shape), shape, border = true) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(title, style = Type.h2, modifier = Modifier.semantics { heading() })
                    description?.let { Text(it, style = Type.sm.copy(lineHeight = Type.body.lineHeight), color = theme.text2) }
                }
                content?.invoke(this)
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(8.dp)) { actions() }
            }
        }
    }
}
@Composable fun Toast(text: String, modifier: Modifier = Modifier) {
    val t = theme
    val shape = RoundedCornerShape(10.dp)
    Row(modifier.padding(16.dp).shadow(10.dp, shape).background(t.text, shape).padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Lucide.Check, null, Modifier.size(16.dp), tint = t.surface)
        Text(text, style = Type.sm, color = t.surface)
    }
}
