package app.harbor0.android

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable fun SharedScreen(model: WorkspaceModel) {
    val shared = model.shared
    val received = shared.tab == "Received"
    val list = shared.transfers
    Refreshable(list.loading && list.data != null, { shared.refresh() }) {
        LazyColumn(Modifier.fillMaxSize().testTag("shared-list"), state = remember(model.epoch) { androidx.compose.foundation.lazy.LazyListState() }, contentPadding = PaddingValues(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                PageTitle("Shared")
                Segmented(listOf("Received" to "Received", "Sent" to "Sent"), shared.tab, shared::select, Modifier.padding(top = 14.dp).width(190.dp))
            }
            val transfers = list.data
            when {
                transfers == null && list.error == null -> item { SkeletonRows() }
                list.error != null && transfers.isNullOrEmpty() -> item { LoadError { shared.refresh() } }
                transfers.isNullOrEmpty() -> item {
                    EmptyState(if (received) Lucide.Inbox else Lucide.Send, if (received) "No received files" else "No sent files",
                        if (received) "People can send files directly to @${model.user?.username.orEmpty()}." else "Choose a file in My Drive and select Send from its menu to share it directly with someone.") {
                        HButton("Browse My Drive", { model.navigate(Section.Drive) }, variant = Variant.Outline, small = true)
                    }
                }
                else -> items(transfers, key = { it.id }) { TransferCard(model, it, received) }
            }
            if (shared.page != null || shared.nextCursor != null) item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                    if (shared.page != null) HButton("First page", { shared.refresh(null) }, variant = Variant.Outline)
                    shared.nextCursor?.let { next -> HButton("Next page", { shared.refresh(next) }, variant = Variant.Outline) }
                }
            }
            val shares = shared.shares
            if (shares.loading && shares.data == null || shares.error != null || !shares.data.isNullOrEmpty()) item {
                Card(Modifier.padding(top = 6.dp)) {
                    CardHeader("Shared access")
                    when {
                        shares.data == null && shares.error == null -> SkeletonRows()
                        shares.error != null && shares.data.isNullOrEmpty() -> LoadError(compact = true) { shared.refresh() }
                        else -> shares.data.orEmpty().forEachIndexed { index, share ->
                            val item = share.item ?: return@forEachIndexed
                            if (index > 0) Divider()
                            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                FileTile(item)
                                Column(Modifier.weight(1f).clickable(role = Role.Button) { openShared(model, item) }) {
                                    Text(item.name, style = Type.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text("${if (share.permission == "EDITOR") "Can edit" else "Can view"} · ${if (share.ownerUserId == model.user?.id) "Shared by you" else "Shared with you"}",
                                        style = Type.xs, color = theme.text2)
                                }
                                if (share.ownerUserId == model.user?.id) HButton("Remove access", { shared.removeAccess(share) }, variant = Variant.Outline, small = true)
                            }
                        }
                    }
                }
            }
        }
    }
}
private fun openShared(model: WorkspaceModel, item: DriveItem) {
    if (!item.isFolder) return model.openFile(item)
    model.navigate(Section.Drive)
    model.drive.enter(item)
}

@Composable private fun TransferCard(model: WorkspaceModel, t: Transfer, received: Boolean) {
    val shared = model.shared
    val (status, tone) = transferStatus(t, received)
    val ready = t.preparationState != "BUILDING" && t.preparationState != "FAILED"
    val extra = shared.entries[t.id]
    val entries = t.items + extra?.first.orEmpty()
    val cursor = if (extra != null) extra.second else t.nextEntryCursor
    val person = if (received) t.sender else t.recipient
    Card(Modifier.testTag("transfer-${t.id}")) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row { Badge(status, tone) }
            t.failure?.let { Alert(it, tone = Tone.Danger) }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (entries.isEmpty()) (t.displayNames.ifEmpty { listOf("Files being prepared") }).forEach { name ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        FileTile(null, mime = null); Text(name, style = Type.body.copy(fontSize = 15.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                entries.forEach { entry ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        FileTile(null, folder = entry.itemType == "FOLDER", mime = entry.mimeType)
                        Text(entry.displayName, Modifier.weight(1f), style = Type.body.copy(fontSize = 15.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (received && t.state == "ACCEPTED" && ready && entry.itemType == "FILE")
                            HIconButton(Lucide.ArrowDownToLine, "Download ${entry.displayName}", { shared.download(t, entry) }, enabled = !model.busy)
                    }
                }
                if (cursor != null) HButton(if (shared.entriesLoading == t.id) "Loading…" else "Show more files", { shared.moreEntries(t) }, variant = Variant.Ghost, small = true,
                    enabled = shared.entriesLoading == null && !model.busy)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                LabeledValue(if (received) "From" else "To", person?.displayName?.ifBlank { null } ?: t.recipientEmail ?: "Unknown recipient", Modifier.weight(1f),
                    sub = person?.let { "@${it.username}" } ?: "Account invitation")
                LabeledValue("Size", bytesLabel(t.totalSizeBytes), Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                LabeledValue("Sent", if (t.createdAt.isBlank()) "—" else dateLabel(t.createdAt), Modifier.weight(1f))
                LabeledValue("Expires", t.expiresAt?.let { dateLabel(it) } ?: "No expiry", Modifier.weight(1f))
            }
            when {
                received && t.state == "PENDING" && ready -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    HButton("Accept", { shared.act(t, "accept") }, Modifier.weight(1f), enabled = !model.busy)
                    HButton("Decline", { shared.act(t, "decline") }, Modifier.weight(1f), Variant.Outline, enabled = !model.busy)
                }
                received && t.state == "ACCEPTED" && ready -> HButton(if (t.savedAt != null) "Saved" else if (t.saveState == "SAVING") "Saving…" else "Save to My Drive",
                    { shared.act(t, "save") }, Modifier.fillMaxWidth(), Variant.Outline, enabled = !model.busy && t.savedAt == null && t.saveState != "SAVING")
                !received && t.preparationState != "BUILDING" && t.state in listOf("PENDING", "PENDING_RECIPIENT_SIGNUP") ->
                    HButton("Cancel transfer", { shared.act(t, "cancel") }, Modifier.fillMaxWidth(), Variant.Outline, enabled = !model.busy)
            }
        }
    }
}
