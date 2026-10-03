package app.harbor0.android

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

// Phone pieces of the web layout (apps/web/app/styles/mobile.css): bottom sheets, chips, checkboxes,
// the floating “New” button, the selection dock and the tab bar.

/** A bottom sheet on the card color with a grab handle, 20dp top corners and an optional title row. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable fun HSheet(onDismiss: () -> Unit, title: String? = null, description: String? = null, divider: Boolean = false,
    tall: Boolean = false, closeLabel: String = "Close", footer: (@Composable ColumnScope.() -> Unit)? = null,
    scroll: Boolean = true, content: @Composable ColumnScope.() -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val palette = theme.palette
    val card = palette.on(palette.card)
    ModalBottomSheet(onDismiss, sheetState = state, shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp), containerColor = card.surface,
        contentColor = card.text, tonalElevation = 0.dp, scrimColor = palette.backdrop,
        dragHandle = { Box(Modifier.padding(top = 8.dp).size(36.dp, 4.dp).background(card.fill3, RoundedCornerShape(2.dp))) },
        contentWindowInsets = { WindowInsets(0, 0, 0, 0) }) {
        CompositionLocalProvider(LocalTokens provides card, LocalContentColor provides card.text) {
            Column(Modifier.fillMaxWidth().then(if (tall) Modifier.fillMaxHeight(.92f) else Modifier).navigationBarsPadding().imePadding()) {
                if (title != null) {
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, top = 12.dp, end = 8.dp, bottom = if (description == null) 8.dp else 0.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text(title, Modifier.weight(1f).semantics { heading() }, style = Type.h2.copy(fontSize = 18.sp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                        HIconButton(Lucide.X, closeLabel, onDismiss)
                    }
                    description?.let { Text(it, Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp), style = Type.sm.copy(lineHeight = 20.sp), color = card.text2) }
                    if (divider) Divider()
                }
                Column(Modifier.weight(1f, fill = tall).then(if (scroll) Modifier.verticalScroll(rememberScrollState()) else Modifier)
                    .padding(start = 20.dp, top = if (title == null) 8.dp else 12.dp, end = 20.dp, bottom = if (footer == null) 20.dp else 12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
                footer?.let {
                    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = it)
                }
            }
        }
    }
}

/** A dialog shown as a bottom sheet on phones. Actions stack full-width, primary first. */
@Composable fun HDialog(title: String, onDismiss: () -> Unit, description: String? = null, actions: @Composable ColumnScope.() -> Unit,
    content: (@Composable ColumnScope.() -> Unit)? = null) {
    HSheet(onDismiss, title, description, footer = actions) { content?.invoke(this) }
}

@Composable fun PageTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.semantics { heading() }, style = Type.body.copy(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight(600), letterSpacing = (-.025).em),
        maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** A square checkbox with a 40dp touch target. */
@Composable fun HCheckbox(checked: Boolean, onChange: (Boolean) -> Unit, label: String, modifier: Modifier = Modifier, indeterminate: Boolean = false, enabled: Boolean = true) {
    val t = theme
    val on = checked || indeterminate
    val shape = RoundedCornerShape(5.dp)
    Box(modifier.size(40.dp).alpha(if (enabled) 1f else .5f).toggleable(checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChange)
        .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Box(Modifier.size(18.dp).clip(shape).background(if (on) t.primary else t.surface).border(1.5.dp, if (on) t.primary else t.strongLine, shape),
            contentAlignment = Alignment.Center) {
            if (on) Icon(if (indeterminate && !checked) Lucide.Minus else Lucide.Check, null, Modifier.size(13.dp), tint = t.onPrimary)
        }
    }
}
@Composable fun HRadio(selected: Boolean, modifier: Modifier = Modifier) {
    val t = theme
    Box(modifier.size(18.dp).border(1.5.dp, if (selected) t.primary else t.strongLine, CircleShape), contentAlignment = Alignment.Center) {
        if (selected) Box(Modifier.size(9.dp).background(t.primary, CircleShape))
    }
}
/** A selectable option with a title and hint, as in the web `.choice` lists. */
@Composable fun Choice(title: String, hint: String, selected: Boolean, onClick: () -> Unit) {
    val t = theme
    val shape = RoundedCornerShape(Radius.lg)
    Row(Modifier.fillMaxWidth().clip(shape).border(1.dp, if (selected) t.primary else t.line, shape).selectable(selected, role = Role.RadioButton, onClick = onClick)
        .padding(14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        HRadio(selected, Modifier.padding(top = 2.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = Type.label.copy(fontSize = 14.sp))
            Text(hint, style = Type.xs, color = t.text2)
        }
    }
}

/** Pill chip used for the Drive filters. */
@Composable fun FilterChip(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, active: Boolean = false, chevron: Boolean = true) {
    val t = theme
    Row(modifier.height(34.dp).clip(CircleShape).background(if (active) t.accentSoft else t.surface)
        .border(1.dp, if (active) t.primary.copy(alpha = .5f) else t.line, CircleShape).clickable(role = Role.Button, onClick = onClick)
        .padding(start = 14.dp, end = if (chevron) 10.dp else 14.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = Type.sm.copy(fontSize = 13.5.sp), color = if (active) t.accentText else t.text, maxLines = 1)
        if (chevron) Icon(Lucide.ChevronDown, null, Modifier.size(15.dp), tint = if (active) t.accentText else t.text2)
    }
}

/** List / grid icon switch. */
@Composable fun ViewSwitch(grid: Boolean, onChange: (Boolean) -> Unit) {
    val t = theme
    Row(Modifier.clip(RoundedCornerShape(10.dp)).background(t.fill2).padding(3.dp).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        listOf(false to Lucide.List, true to Lucide.LayoutGrid).forEach { (value, icon) ->
            val selected = grid == value
            val shape = RoundedCornerShape(7.dp)
            Box(Modifier.size(32.dp, 30.dp).then(if (selected) Modifier.shadow(1.dp, shape).background(t.surface, shape) else Modifier).clip(shape)
                .selectable(selected, role = Role.RadioButton) { onChange(value) }.semantics { contentDescription = if (value) "Grid view" else "List view" },
                contentAlignment = Alignment.Center) {
                Icon(icon, null, Modifier.size(17.dp), tint = if (selected) t.text else t.text2)
            }
        }
    }
}

/** Tinted tile behind a file icon: folders accent, images teal, everything else neutral. */
@Composable fun FileTile(item: DriveItem?, size: Dp = 40.dp, folder: Boolean = item?.isFolder == true, mime: String? = item?.mimeType) {
    val t = theme
    val (icon, fill, tint) = when {
        folder -> Triple(Lucide.Folder, t.accentSoft, t.accentText)
        mime?.startsWith("image/") == true -> Triple(Lucide.FileImage, androidx.compose.ui.graphics.lerp(t.surface, t.palette.kindImage, .13f), t.palette.kindImage)
        mime != null && (mime.contains("pdf") || mime.startsWith("text/")) -> Triple(Lucide.FileText, t.fill2, t.text2)
        else -> Triple(Lucide.File, t.fill2, t.text2)
    }
    Box(Modifier.size(size).background(fill, RoundedCornerShape(size / 4)), contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(size / 2), tint = tint)
    }
}
@Composable fun IconBox(icon: ImageVector, size: Dp = 38.dp, active: Boolean = false) {
    val t = theme
    Box(Modifier.size(size).background(if (active) t.accentSoft else t.fill2, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(18.dp), tint = if (active) t.accentText else t.text2)
    }
}

@Composable fun Fab(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val t = theme
    val shape = RoundedCornerShape(18.dp)
    Box(modifier.size(56.dp).shadow(10.dp, shape, ambientColor = t.primary, spotColor = t.primary).background(t.primary, shape).clip(shape)
        .clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = "New" }.testTag("fab"), contentAlignment = Alignment.Center) {
        Icon(Lucide.Plus, null, Modifier.size(24.dp), tint = t.onPrimary)
    }
}

/** Floating actions shown above the tab bar while items are selected. */
@Composable fun SelectionDock(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    val palette = theme.palette
    val page = palette.on(palette.background)
    val shape = RoundedCornerShape(18.dp)
    CompositionLocalProvider(LocalTokens provides page, LocalContentColor provides page.text) {
        Row(modifier.padding(10.dp).fillMaxWidth().shadow(14.dp, shape).background(page.surface, shape).border(1.dp, page.line, shape).padding(6.dp),
            horizontalArrangement = Arrangement.SpaceAround, verticalAlignment = Alignment.CenterVertically, content = content)
    }
}
@Composable fun RowScope.DockButton(icon: ImageVector, label: String, onClick: () -> Unit, enabled: Boolean = true, iconOnly: Boolean = false) {
    val t = theme
    Column((if (iconOnly) Modifier.width(48.dp) else Modifier.weight(1f)).height(52.dp).clip(RoundedCornerShape(Radius.md)).alpha(if (enabled) 1f else .45f)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { if (iconOnly) contentDescription = label }.padding(horizontal = 2.dp, vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically)) {
        Icon(icon, null, Modifier.size(20.dp), tint = t.text2)
        if (!iconOnly) Text(label, style = Type.xs.copy(fontSize = 11.sp, fontWeight = FontWeight(500)), color = t.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Label and value rows, as the web `.details` list. */
@Composable fun DetailRows(rows: List<Pair<String, String>>) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        rows.forEach { (label, value) ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(label, Modifier.width(96.dp), style = Type.sm, color = theme.text2)
                Text(value, Modifier.weight(1f), style = Type.sm.copy(fontSize = 14.sp))
            }
        }
    }
}

/** Label above value, used in transfer cards. */
@Composable fun LabeledValue(label: String, value: String, modifier: Modifier = Modifier, sub: String? = null) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = Type.xs.copy(fontSize = 11.sp, fontWeight = FontWeight(500)), color = theme.text3)
        Text(value, style = Type.body, maxLines = 2, overflow = TextOverflow.Ellipsis)
        sub?.let { Text(it, style = Type.sm, color = theme.text2) }
    }
}

/** The storage summary from the More sheet and sidebar. */
@Composable fun StorageCard(storage: Storage?, onManage: () -> Unit, modifier: Modifier = Modifier) {
    val t = theme
    Column(modifier.fillMaxWidth().background(t.fill2, RoundedCornerShape(Radius.lg)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Storage", Modifier.weight(1f), style = Type.label.copy(fontSize = 14.sp))
            HButton("Manage storage", onManage, variant = Variant.Link)
        }
        if (storage != null) {
            Progress(storage.usedBytes.toFloat() / maxOf(1, storage.quotaBytes))
            Text("${bytesLabel(storage.usedBytes)} of ${bytesLabel(storage.quotaBytes)}", style = Type.sm, color = t.text2)
        } else Text("Storage unavailable", style = Type.sm, color = t.text2)
    }
}

@Composable fun BrandMark(size: Dp = 26.dp, tint: Color = theme.primary) {
    Icon(painterResource(R.drawable.ic_harbor), null, Modifier.size(size), tint = tint)
}
@Composable fun Wordmark() {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        BrandMark(28.dp)
        Text("harbor0", style = Type.h2.copy(fontSize = 19.sp, fontWeight = FontWeight(650), letterSpacing = (-.02).em))
    }
}
