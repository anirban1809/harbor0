package app.harbor0.android

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable fun TrashScreen(model: WorkspaceModel) {
    val trash = model.trash
    val files = trash.items
    val selection = trash.selection
    Box(Modifier.fillMaxSize()) {
        Refreshable(trash.loading && trash.loaded, { trash.refresh() }) {
            LazyColumn(Modifier.fillMaxSize().testTag("trash-list"), state = remember(model.epoch) { androidx.compose.foundation.lazy.LazyListState() }, contentPadding = PaddingValues(start = 16.dp, top = 12.dp, end = 16.dp, bottom = if (selection.isEmpty()) 32.dp else 104.dp)) {
                item {
                    SearchHeading(model, "Trash", "Items in Trash")
                    Row(Modifier.fillMaxWidth().padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (selection.isNotEmpty()) {
                            Text("${selection.size} selected", Modifier.weight(1f), style = Type.label.copy(fontSize = 15.sp, fontWeight = FontWeight(600)))
                            HIconButton(Lucide.X, "Clear selection", { trash.selected = emptySet() })
                        } else {
                            Badge(when {
                                !trash.loaded && trash.loadError == null -> "Loading…"
                                trash.loadError != null && files.isEmpty() -> "Unavailable"
                                else -> "${files.size} ${if (files.size == 1) "item" else "items"}${if (trash.page != null || trash.nextCursor != null) " on this page" else ""}"
                            })
                            Spacer(Modifier.weight(1f))
                            HButton("Empty Trash", trash::empty, variant = Variant.Outline, icon = Lucide.Trash,
                                enabled = !model.busy && trash.loaded && trash.loadError == null && (files.isNotEmpty() || trash.page != null || trash.nextCursor != null || model.query.isNotBlank()))
                            ViewSwitch(trash.grid) { trash.grid = it }
                        }
                    }
                }
                when {
                    !trash.loaded && trash.loadError == null -> item { SkeletonRows(trash.grid) }
                    trash.loadError != null && files.isEmpty() -> item { LoadError("We couldn’t load these files.") { trash.refresh() } }
                    files.isEmpty() -> item {
                        if (model.query.isNotBlank()) EmptyState(Lucide.Search, "No matching files", "Try a different name or clear your search to see your files again.") {
                            HButton("Clear search", model::clearSearch, variant = Variant.Outline, small = true)
                        } else EmptyState(Lucide.Trash, "Trash is empty", "Files you move to trash will appear here. You can restore them or delete them permanently.") {
                            HButton("Browse My Drive", { model.navigate(Section.Drive) }, variant = Variant.Outline, small = true)
                        }
                    }
                    else -> fileList(files, trash.grid, trash.selected, { trash.selected = it }, { model.overlay = Overlay.TrashMenu(it) }, { model.overlay = Overlay.TrashMenu(it) }, trash = true)
                }
                if (trash.page != null || trash.nextCursor != null) item {
                    Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                        if (trash.page != null) HButton("First page", { trash.selected = emptySet(); trash.refresh(null) }, variant = Variant.Outline)
                        trash.nextCursor?.let { next -> HButton("Next page", { trash.selected = emptySet(); trash.refresh(next) }, variant = Variant.Outline) }
                    }
                }
            }
        }
        if (selection.isNotEmpty()) SelectionDock(Modifier.align(Alignment.BottomCenter)) {
            DockButton(Lucide.RotateCcw, "Restore", { trash.restore(selection) }, !model.busy)
            DockButton(Lucide.Trash, "Delete permanently", { trash.deletePermanently(selection) }, !model.busy)
        }
    }
}

/** The page title, or “Search results” with what was searched and a Clear search button, as the web page heading. */
@Composable fun SearchHeading(model: WorkspaceModel, title: String, scope: String) {
    if (model.query.isBlank()) return PageTitle(title)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            PageTitle("Search results")
            Text("$scope matching “${model.query.trim()}”", Modifier.padding(top = 4.dp), style = Type.sm, color = theme.text2)
        }
        HButton("Clear search", model::clearSearch, variant = Variant.Outline, small = true, icon = Lucide.X)
    }
}

/** File results that replace a page while its search box has text. */
@Composable fun SearchScreen(model: WorkspaceModel) {
    val search = model.search
    val files = search.items
    Refreshable(search.loading && search.loaded, { search.refresh() }) {
        LazyColumn(Modifier.fillMaxSize().testTag("search-list"), contentPadding = PaddingValues(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 32.dp)) {
            item {
                SearchHeading(model, model.section.title, "Files")
                Row(Modifier.fillMaxWidth().padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Badge(when {
                        !search.loaded && search.loadError == null -> "Loading…"
                        search.loadError != null && files.isEmpty() -> "Unavailable"
                        else -> "${files.size} ${if (files.size == 1) "item" else "items"}${if (search.page != null || search.nextCursor != null) " on this page" else ""}"
                    })
                    Spacer(Modifier.weight(1f))
                    ViewSwitch(search.grid) { search.grid = it }
                }
            }
            when {
                !search.loaded && search.loadError == null -> item { SkeletonRows(search.grid) }
                search.loadError != null && files.isEmpty() -> item { LoadError("We couldn’t load these files.") { search.refresh() } }
                files.isEmpty() -> item {
                    EmptyState(Lucide.Search, "No matching files", "Try a different name or clear your search to see your files again.") {
                        HButton("Clear search", model::clearSearch, variant = Variant.Outline, small = true)
                    }
                }
                else -> fileList(files, search.grid, emptySet(), {}, model::openResult, { model.overlay = Overlay.ItemMenu(it) }, selectable = false)
            }
            if (search.page != null || search.nextCursor != null) item {
                Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                    if (search.page != null) HButton("First page", { search.refresh(null) }, variant = Variant.Outline)
                    search.nextCursor?.let { next -> HButton("Next page", { search.refresh(next) }, variant = Variant.Outline) }
                }
            }
        }
    }
}
