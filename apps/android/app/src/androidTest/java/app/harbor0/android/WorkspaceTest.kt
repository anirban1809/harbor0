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
    private fun waitText(text: String) { compose.waitUntil(15_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() } }
    private fun tap(text: String) { waitText(text); compose.onNodeWithText(text).performClick() }
    private fun tab(name: String) { compose.onNodeWithTag("tab-$name").performClick() }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.executeShellCommand("screencap -p /sdcard/Download/harbor0-$name.png").use {
            java.io.FileInputStream(it.fileDescriptor).use { input -> input.readBytes() }
        }
    }
    @Test fun workspaceNavigationFilesTrashAppearanceAndSignOut() {
        waitText("Your files, within reach.")
        screenshot("01-sign-in")
        compose.onNodeWithTag("email").performTextInput("android-test@example.test")
        compose.onNodeWithTag("password").performTextInput("wrong")
        compose.onNodeWithTag("sign-in").performClick()
        waitText("Email or password is incorrect.")
        compose.onNodeWithTag("password").performTextReplacement("fixture-password")
        compose.onNodeWithTag("sign-in").performClick()
        waitText("Welcome.txt")
        compose.onNodeWithText("Studio assets").assertDoesNotExist()
        compose.onNodeWithText("Design archive").assertDoesNotExist()
        screenshot("02-drive")
        tap("Documents")
        compose.onNodeWithContentDescription("Add files or folder").performClick()
        tap("New folder")
        compose.onNodeWithTag("folder-name").performTextInput("Android notes")
        tap("Create folder")
        waitText("Android notes")
        val source = File(compose.activity.cacheDir, "previews/provider-source.txt").apply {
            parentFile!!.mkdirs(); writeText("Android document provider upload.\n".repeat(80_000))
        }
        val uri = androidx.core.content.FileProvider.getUriForFile(compose.activity, compose.activity.packageName + ".files", source)
        compose.runOnIdle { androidx.lifecycle.ViewModelProvider(compose.activity)[WorkspaceModel::class.java].upload(uri) }
        waitText("provider-source.txt")
        tap("provider-source.txt"); waitText("Open file")
        val saved = File(compose.activity.cacheDir, "previews/provider-saved.txt")
        val output = androidx.core.content.FileProvider.getUriForFile(compose.activity, compose.activity.packageName + ".files", saved)
        compose.runOnIdle {
            val model = androidx.lifecycle.ViewModelProvider(compose.activity)[WorkspaceModel::class.java]
            model.saveDownload(output, model.preview!!.file)
        }
        waitText("File saved.")
        assertArrayEquals(source.readBytes(), saved.readBytes())
        tap("Done")
        compose.onNodeWithContentDescription("Actions for provider-source.txt").performClick()
        tap("Move to trash")
        compose.onAllNodesWithText("Move to trash").onLast().performClick()
        compose.waitUntil(15_000) { compose.onAllNodesWithText("provider-source.txt").fetchSemanticsNodes().isEmpty() }
        tab("Trash"); waitText("provider-source.txt")
        compose.onAllNodesWithText("Delete").onLast().performClick()
        tap("Delete permanently")
        compose.waitUntil(15_000) { compose.onAllNodesWithText("provider-source.txt").fetchSemanticsNodes().isEmpty() }
        tab("Sync"); tap("Studio assets"); waitText("Shared brief.txt")
        tab("Drive"); waitText("Android notes")
        tab("Sync"); waitText("Shared brief.txt")
        tab("Backups"); tap("Design archive"); waitText("Saved brief.txt")
        compose.onNodeWithContentDescription("Add files or folder").assertDoesNotExist()
        compose.onNodeWithContentDescription("Actions for Saved brief.txt").assertDoesNotExist()
        screenshot("03-backup-files")
        compose.onNodeWithContentDescription("Backup history").performClick()
        waitText("Automatic backup")
        screenshot("04-backup-history")
        tab("Trash"); waitText("Old notes.txt"); tap("Restore"); waitText("Trash is empty")
        tab("Drive")
        compose.onNodeWithContentDescription("Back").performClick()
        tap("Welcome.txt"); waitText("Open file")
        screenshot("05-download-verified")
        tap("Done")
        tab("Settings"); waitText("Android test account")
        compose.onNodeWithText("Ocean").performScrollTo().performClick()
        compose.onNodeWithText("Save appearance").performScrollTo().performClick()
        waitText("Appearance saved to your account.")
        tab("Drive"); waitText("Welcome.txt")
        screenshot("06-ocean-drive")
        tab("Settings")
        compose.onNodeWithText("Violet").performScrollTo().performClick()
        compose.onNodeWithText("Dark").performScrollTo().performClick()
        compose.onNodeWithText("Save appearance").performScrollTo().performClick()
        waitText("Appearance saved to your account.")
        tab("Drive"); waitText("Welcome.txt")
        screenshot("07-violet-dark")
        compose.activityRule.scenario.close()
        val restored = androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java)
        try {
            waitText("Welcome.txt")
            screenshot("08-restored-session")
            tab("Settings")
            compose.onNodeWithText("Sign out").performScrollTo().performClick()
            waitText("Sign out?")
            compose.onAllNodesWithText("Sign out").onLast().performClick()
            waitText("Your files, within reach.")
        } finally { restored.close() }
    }
}
