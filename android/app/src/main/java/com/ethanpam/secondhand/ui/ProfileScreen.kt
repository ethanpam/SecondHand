package com.ethanpam.secondhand.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import com.ethanpam.secondhand.core.HouseholdMember
import com.ethanpam.secondhand.core.PersonalProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun ProfileScreen(profile: PersonalProfile, onEdit: () -> Unit) {
    Column(Modifier.widthIn(max = 720.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        SectionTitle("Your details, ready when you need them.", "Save once. Review whenever life changes.")
        AppCard {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                IconBadge(Icons.Rounded.PersonOutline)
                Column { Text(listOf(profile.firstName, profile.middleName, profile.lastName).filter { it.isNotBlank() }.joinToString(" ").ifBlank { "Your personal profile" },
                    style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                    Text(profile.reviewedAt?.let { "Confirmed ${displayInstant(it)}" } ?: "Ready for your first review", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            PrimaryButton("Edit and review my profile", onEdit, icon = Icons.Rounded.Edit)
        }
        AppCard {
            SectionTitle("Contact details")
            DetailRow("Email", profile.email)
            DetailRow("Home phone", profile.homePhone)
            DetailRow("Mobile phone", profile.mobilePhone)
            if (profile.phone.isNotBlank()) DetailRow("Other saved phone", profile.phone)
        }
        AppCard {
            SectionTitle("Home address")
            val lines = listOf(profile.addressLine1, profile.addressLine2,
                listOf(profile.city, profile.state, profile.postalCode).filter { it.isNotBlank() }.joinToString(" ")).filter { it.isNotBlank() }
            Text(if (profile.addressLine1.isBlank()) "No home address added yet." else lines.joinToString("\n"), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        AppCard {
            SectionTitle("Household & monthly amounts", "These are your saved notes, not an eligibility calculation.")
            DetailRow("Monthly income", profile.monthlyIncome.ifBlank { "Not added" })
            DetailRow("Monthly housing", profile.monthlyHousingCost.ifBlank { "Not added" })
            if (profile.household.isEmpty()) Text("No household notes added.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            profile.household.forEach { member -> DetailRow(member.name.ifBlank { "Household member" }, member.relationship) }
            if (profile.notes.isNotBlank()) { HorizontalDivider(); Text(profile.notes, style = MaterialTheme.typography.bodyMedium) }
        }
        AppCard {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Rounded.PrivacyTip, null, tint = MaterialTheme.colorScheme.primary)
                Text("You choose when application assistance can use your details. Household notes, written notes, and documents stay in the app.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        StorageNote()
    }
}

@Composable
internal fun ProfileEditor(initial: PersonalProfile, onDismiss: () -> Unit, onSave: suspend (PersonalProfile) -> Unit) {
    var draft by remember { mutableStateOf(initial) }
    var confirmed by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun change(value: PersonalProfile) { draft = value; confirmed = false }
    EditorDialog("Your profile", saving, onDismiss, onSave = {
        saving = true
        scope.launch {
            try { onSave(draft.copy(reviewedAt = if (confirmed) System.currentTimeMillis() else null)) }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = failure.message ?: "Your profile could not be saved." }
            finally { saving = false }
        }
    }) {
        AppCard {
            SectionTitle("Your name")
            InputField("First name", draft.firstName) { change(draft.copy(firstName = it)) }
            InputField("Middle name", draft.middleName) { change(draft.copy(middleName = it)) }
            InputField("Last name", draft.lastName) { change(draft.copy(lastName = it)) }
        }
        AppCard {
            SectionTitle("Contact details", "Keep home and mobile numbers separate so the right number goes in the right field.")
            InputField("Email", draft.email, KeyboardType.Email) { change(draft.copy(email = it)) }
            InputField("Home phone", draft.homePhone, KeyboardType.Phone) { change(draft.copy(homePhone = it)) }
            InputField("Mobile phone", draft.mobilePhone, KeyboardType.Phone) { change(draft.copy(mobilePhone = it)) }
            if (draft.phone.isNotBlank()) InputField("Other phone · stays in the app", draft.phone, KeyboardType.Phone) { change(draft.copy(phone = it)) }
        }
        AppCard {
            SectionTitle("Home address")
            InputField("Home address line 1", draft.addressLine1) { change(draft.copy(addressLine1 = it)) }
            InputField("Apartment or unit", draft.addressLine2) { change(draft.copy(addressLine2 = it)) }
            InputField("City", draft.city) { change(draft.copy(city = it)) }
            InputField("State abbreviation", draft.state) { change(draft.copy(state = it.uppercase().take(2))) }
            InputField("ZIP code", draft.postalCode, KeyboardType.Number) { change(draft.copy(postalCode = it)) }
        }
        AppCard {
            SectionTitle("Monthly amounts", "Use the amounts you have checked. Leave an amount blank when you are unsure.")
            InputField("Monthly income ($)", draft.monthlyIncome, KeyboardType.Decimal) { change(draft.copy(monthlyIncome = it)) }
            InputField("Monthly housing cost ($)", draft.monthlyHousingCost, KeyboardType.Decimal) { change(draft.copy(monthlyHousingCost = it)) }
        }
        AppCard {
            SectionTitle("Household notes", "For your reference. These notes are not shared with the application assistant.")
            draft.household.forEach { member ->
                key(member.id) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Household member", Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                        IconButton(onClick = { change(draft.copy(household = draft.household.filterNot { it.id == member.id })) }) {
                            Icon(Icons.Rounded.DeleteOutline, "Remove household member")
                        }
                    }
                    InputField("Member name", member.name) { value -> change(draft.copy(household = draft.household.map { if (it.id == member.id) it.copy(name = value) else it })) }
                    InputField("Relationship", member.relationship) { value -> change(draft.copy(household = draft.household.map { if (it.id == member.id) it.copy(relationship = value) else it })) }
                    HorizontalDivider()
                }
            }
            TextButton(onClick = { change(draft.copy(household = draft.household + HouseholdMember())) }, enabled = draft.household.size < 20) {
                Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(8.dp)); Text("Add household member")
            }
            OutlinedTextField(value = draft.notes, onValueChange = { change(draft.copy(notes = it)) }, label = { Text("Notes") }, minLines = 3,
                modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.small)
        }
        AppCard {
            Row(verticalAlignment = Alignment.Top) {
                Checkbox(checked = confirmed, onCheckedChange = { confirmed = it })
                Column(Modifier.weight(1f).padding(top = 11.dp)) {
                    Text("I reviewed these details and they are accurate today.", fontWeight = FontWeight.SemiBold)
                    Text("Application sharing requires a review within the last 24 hours. You can also save without confirming.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        StorageNote()
    }
    ErrorDialog(error) { error = null }
}

@Composable
internal fun InputField(label: String, value: String, keyboardType: KeyboardType = KeyboardType.Text, onChange: (String) -> Unit) {
    OutlinedTextField(value = value, onValueChange = onChange, label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType), shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth())
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun EditorDialog(title: String, saving: Boolean, onDismiss: () -> Unit, onSave: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = { if (!saving) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, securePolicy = SecureFlagPolicy.SecureOn)) {
        Scaffold(modifier = Modifier.fillMaxSize(), containerColor = MaterialTheme.colorScheme.background,
            topBar = { TopAppBar(title = { Text(title, fontWeight = FontWeight.Bold) },
                navigationIcon = { IconButton(onClick = onDismiss, enabled = !saving) { Icon(Icons.Rounded.Close, "Close editor") } },
                actions = { TextButton(onClick = onSave, enabled = !saving) { Text(if (saving) "Saving…" else "Save", fontWeight = FontWeight.Bold) } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)) }
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp), content = content)
        }
    }
}
