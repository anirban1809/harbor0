package app.harbor0.android

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

private data class AuthCopy(val title: String, val lead: String, val submit: String, val busy: String)
private val authCopy = mapOf(
    AuthMode.Login to AuthCopy("Welcome back", "Sign in to your files.", "Sign in", "Signing in…"),
    AuthMode.Signup to AuthCopy("Create your account", "50 GB of private storage, free.", "Create your account", "Creating account…"),
    AuthMode.Confirm to AuthCopy("Check your email", "Enter the 6-digit code we sent you.", "Verify email", "Verifying…"),
    AuthMode.Forgot to AuthCopy("Reset your password", "Enter your account email and we’ll send you a reset code.", "Send reset code", "Sending…"),
    AuthMode.Reset to AuthCopy("Set a new password", "Enter the code from your email and choose a new password.", "Reset password", "Saving…"),
)
// Mirrors the Cognito pool policy the web sign-up form shows.
private val passwordRules = listOf<Pair<String, (String) -> Boolean>>(
    "12+ characters" to { it.length >= 12 },
    "Upper & lowercase" to { p -> p.any { it.isLowerCase() } && p.any { it.isUpperCase() } },
    "A number" to { p -> p.any { it.isDigit() } },
    "A symbol" to { p -> p.any { !it.isLetterOrDigit() } },
)
private fun usernameFrom(email: String) = email.substringBefore('@').lowercase().filter { it.isLetterOrDigit() && it.code < 128 || it == '_' || it == '.' }.take(32)

/** Sign in, sign up, email confirmation and password reset, as the web auth page. */
@Composable fun AuthScreen(model: WorkspaceModel) {
    val mode = model.authMode
    val copy = authCopy.getValue(mode)
    val t = theme
    val dark = t.palette.dark
    var password by remember(mode) { mutableStateOf("") }
    var displayName by rememberSaveable { mutableStateOf("") }
    var username by rememberSaveable { mutableStateOf("") }
    var usernameEdited by rememberSaveable { mutableStateOf(false) }
    var code by remember(mode) { mutableStateOf("") }
    var reveal by remember(mode) { mutableStateOf(false) }
    val email = model.authEmail
    val newPassword = mode == AuthMode.Signup || mode == AuthMode.Reset
    val ready = !model.busy && email.isNotBlank() && when (mode) {
        AuthMode.Login -> password.isNotEmpty()
        AuthMode.Signup -> displayName.isNotBlank() && username.length >= 3 && passwordRules.all { it.second(password) }
        AuthMode.Confirm -> code.isNotBlank()
        AuthMode.Forgot -> true
        AuthMode.Reset -> code.isNotBlank() && passwordRules.all { it.second(password) }
    }
    fun submit() {
        if (!ready) return
        when (mode) {
            AuthMode.Login -> model.login(email, password)
            AuthMode.Signup -> model.signup(email, displayName, username, password)
            AuthMode.Confirm -> model.confirmEmail(email, code)
            AuthMode.Forgot -> model.forgot(email)
            AuthMode.Reset -> model.resetPassword(email, code, password)
        }
    }
    Sheet(t.palette.sidebar, Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Top)).imePadding(),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().padding(start = 20.dp, top = 12.dp, end = 12.dp, bottom = 22.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { Wordmark() }
                    HIconButton(if (dark) Lucide.Sun else Lucide.Moon, if (dark) "Switch to light theme" else "Switch to dark theme", { model.toggleTheme(dark) })
                }
                Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Your files, everywhere.", style = Type.display.copy(fontSize = 30.sp, lineHeight = 34.sp), modifier = Modifier.semantics { heading() })
                    Text("Store, sync, and share files across every device you own.", style = Type.body, color = theme.text2)
                    Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Lucide.ShieldCheck, null, Modifier.size(14.dp), tint = theme.text2)
                        Text("Files are private unless you share them.", style = Type.xs, color = theme.text2)
                    }
                }
            }
            Sheet(t.palette.background, Modifier.weight(1f).fillMaxWidth(), RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp), border = true) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                    Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 20.dp, vertical = 26.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(copy.title, style = Type.display.copy(fontSize = 24.sp, letterSpacing = (-.025).em), modifier = Modifier.semantics { heading() })
                            Text(if (mode == AuthMode.Confirm && email.isNotBlank()) "Enter the 6-digit code we sent to ${email.trim()}." else copy.lead, style = Type.sm.copy(fontSize = 14.sp), color = theme.text2)
                        }
                        model.authNotice?.takeIf { it.first == mode }?.let { Alert(it.second, tone = Tone.Success) }
                        Field("Email") {
                            HInput(email, { value -> model.authEmail = value; if (!usernameEdited) username = usernameFrom(value) }, Modifier.testTag("email"), placeholder = "you@example.com",
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false))
                        }
                        if (mode == AuthMode.Signup) {
                            Field("Display name") { HInput(displayName, { displayName = it.take(100) }, Modifier.testTag("display-name"), placeholder = "Your name",
                                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next)) }
                            Field("Username", hint = "People can send files directly to your @username.") {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("@", Modifier.padding(end = 6.dp), style = Type.body, color = theme.text2)
                                    HInput(username, { usernameEdited = true; username = it.lowercase().filter { c -> c in 'a'..'z' || c.isDigit() || c == '_' || c == '.' }.take(32) },
                                        Modifier.testTag("username"), keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Next))
                                }
                            }
                        }
                        if (mode == AuthMode.Confirm || mode == AuthMode.Reset) Field("Verification code") {
                            HInput(code, { code = it.filter(Char::isLetterOrDigit).take(8) }, Modifier.testTag("code"), placeholder = "000000", style = Type.mono.copy(fontSize = 18.sp, letterSpacing = .2.em),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Next))
                        }
                        if (mode == AuthMode.Login || newPassword) Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(if (mode == AuthMode.Reset) "New password" else "Password", Modifier.weight(1f), style = Type.label)
                                if (mode == AuthMode.Login) HButton("Forgot password?", { model.authGo(AuthMode.Forgot) }, variant = Variant.Link)
                            }
                            Box(contentAlignment = Alignment.CenterEnd) {
                                HInput(password, { password = it }, Modifier.testTag("password"), visualTransformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation(),
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { submit() }))
                                HIconButton(if (reveal) Lucide.EyeOff else Lucide.Eye, if (reveal) "Hide password" else "Show password", { reveal = !reveal })
                            }
                            if (newPassword) Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                passwordRules.forEach { (label, test) ->
                                    val met = test(password)
                                    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Icon(Lucide.Check, null, Modifier.size(12.dp), tint = if (met) theme.successText else theme.text3)
                                        Text(label, style = Type.xs.copy(fontSize = 11.sp), color = if (met) theme.successText else theme.text2, maxLines = 1)
                                    }
                                }
                            }
                        }
                        model.authError?.let { (text, unverified) ->
                            Alert(text, tone = Tone.Danger, action = if (unverified) "Verify now" else null) { model.resend(goConfirm = true) }
                        }
                        HButton(if (model.busy) copy.busy else copy.submit, ::submit, Modifier.fillMaxWidth().height(48.dp).testTag("sign-in"), enabled = ready)
                        if (mode == AuthMode.Confirm || mode == AuthMode.Reset) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("Didn’t get it?", style = Type.sm, color = theme.text2)
                            if (mode == AuthMode.Confirm) HButton(if (model.cooldown > 0) "Resend in ${model.cooldown}s" else "Resend code", { model.resend() }, variant = Variant.Link,
                                enabled = !model.busy && model.cooldown == 0)
                            else HButton("Send a new code", { model.authGo(AuthMode.Forgot) }, variant = Variant.Link)
                        }
                        Divider()
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            when (mode) {
                                AuthMode.Login -> { Text("New to harbor0?", style = Type.sm, color = theme.text2); HButton("Create an account", { model.authGo(AuthMode.Signup) }, variant = Variant.Link) }
                                AuthMode.Signup -> { Text("Already have an account?", style = Type.sm, color = theme.text2); HButton("Sign in", { model.authGo(AuthMode.Login) }, variant = Variant.Link) }
                                else -> HButton("Back to sign in", { model.authGo(AuthMode.Login) }, variant = Variant.Link)
                            }
                        }
                        if (mode == AuthMode.Login && model.api.canRestore) Column {
                            HButton("Retry saved sign-in", model::restore, variant = Variant.Link, enabled = !model.busy)
                            HButton("Remove saved sign-in from this device", model::forget, variant = Variant.Link, enabled = !model.busy)
                            model.error?.let { Text(it, Modifier.padding(top = 6.dp), style = Type.xs, color = theme.dangerText) }
                        }
                    }
                }
            }
        }
    }
}
