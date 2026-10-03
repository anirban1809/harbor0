package app.harbor0.android

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class WorkspaceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun waitText(text: String, substring: Boolean = false) {
        compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun waitGone(text: String) { compose.waitUntil(15_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty() } }
    private fun tap(text: String) { waitText(text); compose.onAllNodesWithText(text).onFirst().performClick() }
    private fun tapLabel(label: String) {
        compose.waitUntil(15_000) { compose.onAllNodesWithContentDescription(label).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithContentDescription(label).onFirst().performClick()
    }
    /** Opens a pinned place or a device inside one (virtual folders tagged by name). */
    private fun place(name: String) {
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("file-$name").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("file-$name").performClick()
    }
    private fun tab(name: String) { compose.onNodeWithTag("tab-$name").performClick() }
    private fun model() = androidx.lifecycle.ViewModelProvider(compose.activity)[WorkspaceModel::class.java]
    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.executeShellCommand("screencap -p /sdcard/Download/harbor0-$name.png").use {
            java.io.FileInputStream(it.fileDescriptor).use { input -> input.readBytes() }
        }
    }
    @Test fun phoneLayoutFilesSharedBackupsTrashSettingsAndSignOut() {
        waitText("Your files, everywhere.")
        screenshot("01-sign-in")
        compose.onNodeWithTag("email").performTextInput("android-test@example.test")
        compose.onNodeWithTag("password").performTextInput("wrong")
        compose.onNodeWithTag("sign-in").performScrollTo().performClick()
        waitText("Email or password is incorrect.")
        compose.onNodeWithTag("password").performTextReplacement("fixture-password")
        compose.onNodeWithTag("sign-in").performScrollTo().performClick()
        waitText("Welcome.txt")
        // Cloud shows neither the synced folder nor the backup folder.
        compose.onNodeWithText("Studio assets").assertDoesNotExist()
        compose.onNodeWithText("Design archive").assertDoesNotExist()
        screenshot("02-drive")

        // New folder from the floating “New” menu.
        tap("Documents"); waitText("This folder is empty")
        tapLabel("New"); tap("New folder")
        compose.onNodeWithTag("folder-name").performTextInput("Android notes")
        compose.onNodeWithTag("name-submit").performClick()
        waitText("Android notes")

        // Upload through the queue, then open, verify and save a copy.
        val source = File(compose.activity.cacheDir, "previews/provider-source.txt").apply {
            parentFile!!.mkdirs(); writeText("Android document provider upload.\n".repeat(80_000))
        }
        val uri = androidx.core.content.FileProvider.getUriForFile(compose.activity, compose.activity.packageName + ".files", source)
        compose.runOnIdle { model().upload(uri) }
        waitText("Uploads complete")
        tapLabel("Dismiss finished uploads")
        waitText("provider-source.txt")
        tap("provider-source.txt"); waitText("Download verified")
        val saved = File(compose.activity.cacheDir, "previews/provider-saved.txt")
        val output = androidx.core.content.FileProvider.getUriForFile(compose.activity, compose.activity.packageName + ".files", saved)
        compose.runOnIdle { model().saveDownload(output, model().preview!!.file) }
        waitText("File saved.")
        assertArrayEquals(source.readBytes(), saved.readBytes())
        tap("Done")

        // Rename selects the base name; favorites show a star; trash asks first.
        tapLabel("Actions for Android notes"); tap("Rename")
        compose.onNodeWithTag("folder-name").performTextReplacement("Android notes 2")
        compose.onNodeWithTag("name-submit").performClick()
        waitText("Android notes 2")
        tapLabel("Actions for provider-source.txt"); tap("Add to favorites")
        compose.waitUntil(15_000) { compose.onAllNodesWithContentDescription("Favorite").fetchSemanticsNodes().isNotEmpty() }
        tapLabel("Actions for provider-source.txt"); tap("Move to trash")
        compose.onNodeWithTag("confirm").performClick()
        waitGone("provider-source.txt")

        tab("Trash"); waitText("provider-source.txt")
        screenshot("10-trash")
        tap("provider-source.txt"); tap("Delete permanently")
        compose.onNodeWithTag("confirm").performClick()
        waitGone("provider-source.txt")

        // Synced Folders, Backups and Archives are places in My Drive, grouped by device.
        tab("Drive"); place("Synced Folders"); place("Studio Mac"); tap("Studio assets"); waitText("Shared brief.txt")
        tab("Drive"); place("Backups"); place("Studio Mac"); tap("Design archive"); waitText("Saved brief.txt")
        compose.onNodeWithContentDescription("New").assertDoesNotExist()
        screenshot("03-backup-files")
        // An archive whose device is gone is grouped under the name it was saved with.
        tab("Drive"); place("Archives"); waitText("Old laptop"); place("Studio Mac"); waitText("Old projects")

        // The Backups page: folder status, files and run history.
        tab("Backups"); tap("Design archive"); waitText("Saved brief.txt")
        tap("History"); waitText("Automatic backup", substring = true)
        screenshot("04-backup-history")

        tab("Trash"); tap("Old notes.txt"); tap("Restore"); waitText("Trash is empty")
        tab("Drive"); tap("Welcome.txt"); waitText("Download verified")
        screenshot("05-download-verified")
        tap("Done")

        // Shared: accept a received transfer.
        tab("Shared"); waitText("Waiting for you")
        tap("Accept"); waitText("Save to My Drive")

        // Search stays on the current page: results replace Shared until the search is cleared.
        compose.onNodeWithTag("search").performTextInput("Welcome")
        waitText("Files matching “Welcome”")
        waitText("Welcome.txt")
        compose.onNodeWithTag("tab-Shared").assertIsSelected()
        tap("Clear search"); waitText("Save to My Drive")
        // Trash searches deleted items only.
        tab("Trash"); compose.onNodeWithTag("search").performTextInput("Welcome")
        waitText("Items in Trash matching “Welcome”"); waitText("No matching files")
        tap("Clear search"); waitText("Trash is empty")

        // More → Settings: presets save to the account.
        tab("More"); compose.onNodeWithTag("more-Settings").performClick()
        waitText("Android test account")
        screenshot("09-settings")
        compose.onNodeWithTag("preset-Ocean").performScrollTo().performClick()
        waitText("Saved to your account.")
        tab("Drive"); waitText("Welcome.txt")
        screenshot("06-ocean-drive")
        tab("More"); compose.onNodeWithTag("more-Settings").performClick()
        compose.onNodeWithTag("preset-Violet").performScrollTo().performClick()
        compose.onNodeWithText("Dark").performScrollTo().performClick()
        waitText("Saved to your account.")
        tab("Drive"); waitText("Welcome.txt")
        screenshot("07-violet-dark")

        compose.activityRule.scenario.close()
        val restored = androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java)
        try {
            waitText("Welcome.txt")
            screenshot("08-restored-session")
            tapLabel("Account menu")
            tap("Sign out")
            waitText("Your files, everywhere.")
        } finally { restored.close() }
    }
}
