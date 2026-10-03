package app.harbor0.android

import org.junit.Assert.*
import org.junit.Test

class PlacesTest {
    private val mac = Device("mac", "Studio Mac", "MACOS", status = "ACTIVE", devicePublicId = "mac-key")
    private val phone = Device("phone", "Pixel", "ANDROID", status = "ACTIVE")
    private val web = Device("web", "Chrome", "WEB", status = "ACTIVE")
    private val revoked = Device("old", "Old Mac", "MACOS", status = "REVOKED")
    private fun root(id: String, state: String, deviceId: String = "", name: String? = null, key: String? = null) =
        BackupRoot(id, "Folder $id", "item-$id", state, deviceName = name, deviceId = deviceId, devicePublicId = key)

    @Test fun syncedFoldersGroupByDeviceAndSkipBrowsersAndRevoked() {
        val folders = listOf(
            DriveItem("b", "Beta", "FOLDER", syncDevices = listOf(SyncDevice("mac", "Studio Mac"), SyncDevice("web", "Chrome"))),
            DriveItem("a", "Alpha", "FOLDER", syncDevices = listOf(SyncDevice("mac", "Studio Mac"), SyncDevice("old", "Old Mac"))),
            DriveItem("n", "Nowhere", "FOLDER"),
        )
        val groups = placeGroups(Place.Synced, listOf(mac, phone, web, revoked), folders, emptyList())
        assertEquals(listOf("mac"), groups.map { it.id })
        assertEquals(listOf("Alpha", "Beta"), groups[0].folders.map { it.name })
    }

    @Test fun backupsAndArchivesMatchByKeyThenSessionThenNameAndKeepOrphans() {
        val roots = listOf(
            root("1", "ACTIVE", deviceId = "someone-else", key = "mac-key"),
            root("2", "PAUSED", deviceId = "phone"),
            root("3", "ARCHIVED", name = "Studio Mac"),
            root("4", "ARCHIVED", deviceId = "gone", name = "Old laptop"),
            root("5", "ARCHIVED", deviceId = "gone"),
            root("6", "REMOVED", deviceId = "phone"),
            // Both have device keys and they differ: the session id is not used.
            root("7", "ERROR", deviceId = "mac", key = "other-key", name = "Elsewhere"),
        )
        val devices = listOf(mac, phone, web)
        val backups = placeGroups(Place.Backups, devices, emptyList(), roots)
        assertEquals(listOf("Elsewhere", "Pixel", "Studio Mac"), backups.map { it.name })
        assertEquals(listOf("item-1"), backups.first { it.id == "mac" }.folders.map { it.id })
        assertNull(backups.first { it.name == "Elsewhere" }.device)
        val archives = placeGroups(Place.Archives, devices, emptyList(), roots)
        assertEquals(listOf("Old laptop", "Other device", "Studio Mac"), archives.map { it.name })
        assertEquals("backup-3", archives.last().folders.single().let { "backup-" + it.backupRootId })
    }

    @Test fun usageSumsUniqueIdsAndWaitsForEveryFolder() {
        val usage = mapOf("a" to Usage("a", 1_000, 2), "b" to Usage("b", 500, 1))
        assertEquals(UsageTotal(1_500, 3, true), sumUsage(listOf("a", "b", "a"), usage))
        assertNull(sumUsage(listOf("a", "missing"), usage))
        assertEquals(UsageTotal(0, 0, true), sumUsage(emptyList(), usage))
        assertEquals("1.5 KB", usageLabel(sumUsage(listOf("a", "b"), usage)!!))
    }

    @Test fun partialUsageReadsAsALowerBound() {
        val usage = mapOf("a" to Usage("a", 4_200_000_000, 10, complete = false), "b" to Usage("b", 0, 0))
        val total = sumUsage(listOf("a", "b"), usage)!!
        assertFalse(total.complete)
        assertEquals("At least 4.2 GB", usageLabel(total))
        assertEquals("4.2 GB+", usageLabel(total, tight = true))
    }

    @Test fun placeFolderIdsFollowRootStates() {
        val roots = listOf(root("1", "ACTIVE"), root("2", "ERROR"), root("3", "ARCHIVED"), root("4", "REMOVED"), root("1b", "PAUSED").copy(remoteRootDriveItemId = "item-1"))
        assertEquals(listOf("item-1", "item-2"), placeFolderIds(Place.Backups, emptyList(), roots))
        assertEquals(listOf("item-3"), placeFolderIds(Place.Archives, emptyList(), roots))
        assertEquals(listOf("s"), placeFolderIds(Place.Synced, listOf(DriveItem("s", "S", "FOLDER"), DriveItem("s", "S", "FOLDER")), roots))
    }
}
