package app.harbor0.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay
import java.io.File

/** System pickers, launched from deep inside the UI. */
class Pickers(val uploadFiles: () -> Unit, val uploadFolder: () -> Unit, val saveAs: (File) -> Unit,
    /** Chooses a folder on the phone for sync or backup; the callback receives its document tree. */
    val chooseFolder: ((android.net.Uri) -> Unit) -> Unit = {})
val LocalPickers = staticCompositionLocalOf { Pickers({}, {}, {}) }

class MainActivity: ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val model: WorkspaceModel = viewModel()
            HarborTheme(model.appearance) {
                // Inside the activity `theme` is Activity.getTheme(), so read the tokens directly.
                val palette = LocalTokens.current.palette
                val auth = !model.signedIn && !model.restoring
                val lightTop = ink(if (auth) palette.sidebar else palette.background) == Color.Black
                val lightBottom = ink(palette.background) == Color.Black
                SideEffect { WindowCompat.getInsetsController(window, window.decorView).apply { isAppearanceLightStatusBars = lightTop; isAppearanceLightNavigationBars = lightBottom } }
                HarborApp(model)
            }
        }
    }
}

@Composable fun HarborApp(model: WorkspaceModel) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> { if (!model.foreground) { model.foreground = true; model.resumed() } }
                Lifecycle.Event.ON_STOP -> model.foreground = false
                else -> {}
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    var fileToSave by remember { mutableStateOf<File?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if (uri != null) fileToSave?.let { model.saveDownload(uri, it) }; fileToSave = null
    }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { if (it.isNotEmpty()) model.uploads.addUris(it) }
    val folder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { it?.let(model.uploads::addTree) }
    val chosen = remember { arrayOfNulls<(android.net.Uri) -> Unit>(1) }
    val tree = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri -> uri?.let { chosen[0]?.invoke(it) }; chosen[0] = null }
    val pickers = remember { Pickers({ files.launch(arrayOf("*/*")) }, { folder.launch(null) }, { fileToSave = it; save.launch(it.name) },
        { callback -> chosen[0] = callback; tree.launch(null) }) }
    LaunchedEffect(model.toast) { if (model.toast != null) { delay(4500); model.toast = null } }
    BackHandler(model.signedIn && model.canGoBack) { model.back() }
    BackHandler(!model.signedIn && !model.restoring && model.authMode != AuthMode.Login) { model.authGo(AuthMode.Login) }
    CompositionLocalProvider(LocalPickers provides pickers) {
        when {
            model.restoring -> Sheet(theme.palette.background, Modifier.fillMaxSize()) {
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically)) {
                    BrandMark(40.dp)
                    Progress(null, Modifier.width(120.dp), height = 4.dp)
                    Text("Opening harbor0…", style = Type.sm, color = theme.text2)
                }
            }
            !model.signedIn -> AuthScreen(model)
            else -> Shell(model)
        }
    }
}
