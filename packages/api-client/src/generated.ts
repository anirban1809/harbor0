export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Health */
        get: operations["get__health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/signup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a Cognito account */
        post: operations["post__v1_auth_signup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/request-access": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Email a beta sign-up link, or join the waitlist when the current wave is full */
        post: operations["post__v1_auth_request_access"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/beta": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Whether sign-up needs a beta link and whether requests get one at once */
        get: operations["get__v1_beta"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/beta/invites/{code}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The email address a beta sign-up link was sent to */
        get: operations["get__v1_beta_invites__code"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Verify email */
        post: operations["post__v1_auth_confirm"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/resend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resend verification */
        post: operations["post__v1_auth_resend"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign in */
        post: operations["post__v1_auth_login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rotate refresh credentials */
        post: operations["post__v1_auth_refresh"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke session */
        post: operations["post__v1_auth_logout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/forgot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request password reset */
        post: operations["post__v1_auth_forgot"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reset password */
        post: operations["post__v1_auth_reset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/session/challenge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Issue a challenge for this session to sign with its device key */
        post: operations["post__v1_auth_session_challenge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Register a managed-login session */
        post: operations["post__v1_auth_session"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Current account and quota */
        get: operations["get__v1_users_me"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update profile */
        patch: operations["patch__v1_users_me"];
        trace?: never;
    };
    "/v1/storage/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List every stored file version counted toward storage */
        get: operations["get__v1_storage_audit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/me/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Delete the account; its data is purged 30 days later */
        post: operations["post__v1_users_me_delete"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Find recipients by username prefix or exact email */
        get: operations["get__v1_users_search"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/contacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** People this account exchanges files with most */
        get: operations["get__v1_users_contacts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/lookup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Look up an exact username */
        get: operations["get__v1_users_lookup"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/items/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read item metadata */
        get: operations["get__v1_drive_items__id"];
        put?: never;
        post?: never;
        /** Move to trash */
        delete: operations["delete__v1_drive_items__id"];
        options?: never;
        head?: never;
        /** Rename an item */
        patch: operations["patch__v1_drive_items__id"];
        trace?: never;
    };
    "/v1/drive/folders/{id}/children": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List a folder */
        get: operations["get__v1_drive_folders__id_children"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/folders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create folder */
        post: operations["post__v1_drive_folders"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/items/{id}/move": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Move an item */
        post: operations["post__v1_drive_items__id_move"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/items/{id}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Restore from trash */
        post: operations["post__v1_drive_items__id_restore"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/items/{id}/permanent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Permanently delete a trashed item */
        delete: operations["delete__v1_drive_items__id_permanent"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/trash/empty": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Empty the trash at once; content is deleted in the background (cursor is ignored, nextCursor is always null) */
        post: operations["post__v1_drive_trash_empty"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/items/{id}/favorite": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Change favorite */
        put: operations["put__v1_drive_items__id_favorite"];
        post?: never;
        /** Change favorite */
        delete: operations["delete__v1_drive_items__id_favorite"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search file metadata */
        get: operations["get__v1_search"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/items/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List file versions */
        get: operations["get__v1_drive_items__id_versions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/items/{id}/versions/{versionId}/restore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Restore a version */
        post: operations["post__v1_drive_items__id_versions__versionId_restore"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reserve quota and create upload */
        post: operations["post__v1_uploads"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resume an upload */
        get: operations["get__v1_uploads__id"];
        put?: never;
        post?: never;
        /** Abort upload and release reservation */
        delete: operations["delete__v1_uploads__id"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{id}/parts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign upload part URLs */
        post: operations["post__v1_uploads__id_parts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Finalize upload atomically */
        post: operations["post__v1_uploads__id_complete"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/folder-downloads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Prepare one folder ZIP in the background */
        post: operations["post__v1_folder_downloads"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/folder-downloads/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read ZIP preparation progress */
        get: operations["get__v1_folder_downloads__id"];
        put?: never;
        post?: never;
        /** Cancel ZIP preparation */
        delete: operations["delete__v1_folder_downloads__id"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/downloads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Authorize a short-lived download */
        post: operations["post__v1_downloads"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/transfers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Send files to a person */
        post: operations["post__v1_transfers"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/transfers/received": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List received transfers */
        get: operations["get__v1_transfers_received"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/transfers/sent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List sent transfers */
        get: operations["get__v1_transfers_sent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/transfers/{id}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** accept a transfer */
        post: operations["post__v1_transfers__id_accept"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/transfers/{id}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** decline a transfer */
        post: operations["post__v1_transfers__id_decline"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/transfers/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** cancel a transfer */
        post: operations["post__v1_transfers__id_cancel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/transfers/{id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a transfer manifest page */
        get: operations["get__v1_transfers__id_items"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/transfers/{id}/save": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Save an accepted transfer */
        post: operations["post__v1_transfers__id_save"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/shares": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Grant authenticated access */
        post: operations["post__v1_shares"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/shares/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove shared access */
        delete: operations["delete__v1_shares__id"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/shares/received": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List received shares */
        get: operations["get__v1_shares_received"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/shares/sent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List sent shares */
        get: operations["get__v1_shares_sent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List connected devices */
        get: operations["get__v1_devices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/devices/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Register this device */
        post: operations["post__v1_sync_devices_register"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/devices/current/push": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Register this device for change wake-ups (iOS Files extension) */
        put: operations["put__v1_devices_current_push"];
        post?: never;
        /** Stop change wake-ups for this device */
        delete: operations["delete__v1_devices_current_push"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/devices/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke a device: stop its sync and archive its backups in the cloud */
        delete: operations["delete__v1_devices__id"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/devices/{id}/sign-out": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign a device out; its sync and backups pause until it signs in again */
        post: operations["post__v1_devices__id_sign_out"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/shares": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List sent and received sync invitations */
        get: operations["get__v1_sync_shares"];
        put?: never;
        /** Invite another account to two-way folder sync */
        post: operations["post__v1_sync_shares"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/shares/{id}/respond": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Accept or decline a sync invitation */
        post: operations["post__v1_sync_shares__id_respond"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/shares/{id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read an accepted shared folder revision */
        get: operations["get__v1_sync_shares__id_status"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/realtime/tickets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Issue a one-time ticket for the live updates connection */
        post: operations["post__v1_realtime_tickets"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/folders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List synced folders across devices */
        get: operations["get__v1_sync_folders"];
        /** Replace this device’s synced folders */
        put: operations["put__v1_sync_folders"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/folders/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a folder from sync on all linked devices, preserving local files */
        delete: operations["delete__v1_sync_folders__id"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/drive/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the storage used by folders, every stored version included */
        get: operations["get__v1_drive_usage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read file and folder delivery status */
        get: operations["get__v1_sync_status"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/items/{id}/acknowledge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm a verified local copy */
        post: operations["post__v1_sync_items__id_acknowledge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/items/{id}/request-content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request a temporary copy from a synced device */
        post: operations["post__v1_sync_items__id_request_content"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read ordered durable changes */
        get: operations["get__v1_sync_changes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/checkpoints": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Advance device checkpoint */
        post: operations["post__v1_sync_checkpoints"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sync/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Apply offline operations */
        post: operations["post__v1_sync_operations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List notifications */
        get: operations["get__v1_notifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/{id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark notification read */
        post: operations["post__v1_notifications__id_read"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List backup roots */
        get: operations["get__v1_backups"];
        put?: never;
        /** Create backup root */
        post: operations["post__v1_backups"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get backup connection */
        get: operations["get__v1_backups__id"];
        put?: never;
        post?: never;
        /** Disconnect backup and keep its cloud folder */
        delete: operations["delete__v1_backups__id"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/forget": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Remove a stopped backup and its history from the list */
        post: operations["post__v1_backups__id_forget"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop a backup and keep only its cloud copy */
        post: operations["post__v1_backups__id_archive"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/unarchive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume an archived backup on its computer */
        post: operations["post__v1_backups__id_unarchive"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/runs/{runId}/folders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create folder in a backup run */
        post: operations["post__v1_backups__id_runs__runId_folders"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/runs/{runId}/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Append a backup file version */
        post: operations["post__v1_backups__id_runs__runId_uploads"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List backup runs */
        get: operations["get__v1_backups__id_runs"];
        put?: never;
        /** Start backup run */
        post: operations["post__v1_backups__id_runs"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/restores": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List backup restores */
        get: operations["get__v1_backups__id_restores"];
        put?: never;
        /** Restore a backup version to its local folder */
        post: operations["post__v1_backups__id_restores"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/pending-restores": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List backup pending-restores */
        get: operations["get__v1_backups__id_pending_restores"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/runs/{runId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List files covered by a backup */
        get: operations["get__v1_backups__id_runs__runId_files"];
        put?: never;
        /** Record a backed up file */
        post: operations["post__v1_backups__id_runs__runId_files"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/runs/{runId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete backup run */
        post: operations["post__v1_backups__id_runs__runId_complete"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/backups/{id}/restores/{restoreId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record local restore result */
        post: operations["post__v1_backups__id_restores__restoreId_complete"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/billing/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Available storage capacity */
        get: operations["get__v1_billing_plans"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/billing/subscription": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Current storage entitlement */
        get: operations["get__v1_billing_subscription"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Check metadata availability */
        get: operations["get__ready"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    get__health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        status: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_signup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                    password: string;
                    username: string;
                    displayName: string;
                    inviteCode?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        verificationRequired: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_request_access: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "INVITED" | "WAITLISTED" | "REGISTERED";
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_beta: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        inviteRequired: boolean;
                        open: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_beta_invites__code: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                code: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        email: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_confirm: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                    code: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        verified: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_resend: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        sent: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_login: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                    password: string;
                    /** @default Web browser */
                    deviceName?: string;
                    /**
                     * @default WEB
                     * @enum {string}
                     */
                    platform?: "WEB" | "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        accessToken: string;
                        refreshToken: string;
                        expiresIn: number;
                        device: {
                            id: string;
                            userId: string;
                            name: string;
                            /** @enum {string} */
                            platform: "WEB" | "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID";
                            appVersion: string | null;
                            devicePublicId: string | null;
                            /** @default null */
                            keyFingerprint: string | null;
                            lastSeenAt: string | null;
                            createdAt: string;
                            revokedAt: string | null;
                            /** @enum {string} */
                            status?: "ACTIVE" | "SIGNED_OUT" | "REVOKED";
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_refresh: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    refreshToken: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        accessToken: string;
                        refreshToken: string;
                        expiresIn: number;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_logout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    refreshToken: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        loggedOut: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_forgot: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        sent: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_reset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                    code: string;
                    password: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        reset: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_session_challenge: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        challenge: string;
                        userId: string;
                        expiresAt: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_auth_session: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    /** @enum {string} */
                    platform: "WEB" | "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID";
                    devicePublicId?: string;
                    appVersion?: string;
                    proof?: {
                        publicKey: string;
                        challenge: string;
                        signature: string;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        device: {
                            id: string;
                            userId: string;
                            name: string;
                            /** @enum {string} */
                            platform: "WEB" | "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID";
                            appVersion: string | null;
                            devicePublicId: string | null;
                            /** @default null */
                            keyFingerprint: string | null;
                            lastSeenAt: string | null;
                            createdAt: string;
                            revokedAt: string | null;
                            /** @enum {string} */
                            status?: "ACTIVE" | "SIGNED_OUT" | "REVOKED";
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_users_me: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        user: {
                            id: string;
                            email: string;
                            emailVerified: boolean;
                            username: string;
                            displayName: string;
                            avatarUrl: string | null;
                            appearance?: {
                                /** @enum {string} */
                                preference: "light" | "dark" | "system";
                                /** @enum {string} */
                                preset: "default" | "ocean" | "forest" | "violet" | "sunset";
                                palettes: {
                                    light: {
                                        primary?: string;
                                        background?: string;
                                        card?: string;
                                        sidebar?: string;
                                        border?: string;
                                    };
                                    dark: {
                                        primary?: string;
                                        background?: string;
                                        card?: string;
                                        sidebar?: string;
                                        border?: string;
                                    };
                                };
                            };
                            storageQuotaBytes: number;
                            storageUsedBytes: number;
                            storageReservedBytes: number;
                            createdAt: string;
                            updatedAt: string;
                        };
                        storage: {
                            quotaBytes: number;
                            usedBytes: number;
                            reservedBytes: number;
                            availableBytes: number;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    patch__v1_users_me: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    username?: string;
                    displayName?: string;
                    appearance?: {
                        /** @enum {string} */
                        preference: "light" | "dark" | "system";
                        /** @enum {string} */
                        preset: "default" | "ocean" | "forest" | "violet" | "sunset";
                        palettes: {
                            light: {
                                primary?: string;
                                background?: string;
                                card?: string;
                                sidebar?: string;
                                border?: string;
                            };
                            dark: {
                                primary?: string;
                                background?: string;
                                card?: string;
                                sidebar?: string;
                                border?: string;
                            };
                        };
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        user: {
                            id: string;
                            email: string;
                            emailVerified: boolean;
                            username: string;
                            displayName: string;
                            avatarUrl: string | null;
                            appearance?: {
                                /** @enum {string} */
                                preference: "light" | "dark" | "system";
                                /** @enum {string} */
                                preset: "default" | "ocean" | "forest" | "violet" | "sunset";
                                palettes: {
                                    light: {
                                        primary?: string;
                                        background?: string;
                                        card?: string;
                                        sidebar?: string;
                                        border?: string;
                                    };
                                    dark: {
                                        primary?: string;
                                        background?: string;
                                        card?: string;
                                        sidebar?: string;
                                        border?: string;
                                    };
                                };
                            };
                            storageQuotaBytes: number;
                            storageUsedBytes: number;
                            storageReservedBytes: number;
                            createdAt: string;
                            updatedAt: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_storage_audit: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        rows: {
                            itemId: string;
                            versionId: string;
                            path: string;
                            /** @enum {string} */
                            location: "MY_DRIVE" | "BACKUP" | "SYNC" | "TRASH" | "DELETING";
                            locationDetail: string | null;
                            /** @enum {string} */
                            state: "CURRENT" | "PREVIOUS_VERSION" | "RETAINED_FOR_TRANSFER" | "ON_DEVICES_ONLY";
                            versionNumber: number;
                            sizeBytes: number;
                            countedBytes: number;
                            contentHash: string;
                            uploadedAt: string;
                            uploadedFrom: string | null;
                        }[];
                        storage: {
                            quotaBytes: number;
                            usedBytes: number;
                            reservedBytes: number;
                            availableBytes: number;
                        };
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_users_me_delete: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    /** Format: email */
                    email: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        deletedAt: string;
                        purgeAt: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_users_search: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        users: {
                            id: string;
                            username: string;
                            displayName: string;
                            avatarUrl?: string | null;
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_users_contacts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        users: {
                            id: string;
                            username: string;
                            displayName: string;
                            avatarUrl?: string | null;
                            exchangeCount: number;
                            lastExchangedAt: string;
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_users_lookup: {
        parameters: {
            query?: {
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        users: {
                            username: string;
                            displayName: string;
                            id: string;
                            avatarUrl: string | null;
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_drive_items__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_drive_items__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    baseRevision: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    patch__v1_drive_items__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    baseRevision: number;
                    name: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_drive_folders__id_children: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_drive_folders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    /** @default null */
                    parentId?: string | null;
                    name: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_drive_items__id_move: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    baseRevision: number;
                    parentId: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_drive_items__id_restore: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    baseRevision: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_drive_items__id_permanent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    baseRevision: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        deleted: boolean;
                        jobId?: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_drive_trash_empty: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    cursor?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        count: number;
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    put__v1_drive_items__id_favorite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    baseRevision: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_drive_items__id_favorite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    baseRevision: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_search: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                q?: string;
                type?: string;
                mimeType?: string;
                extension?: string;
                parentId?: string;
                createdAfter?: string;
                createdBefore?: string;
                updatedAfter?: string;
                updatedBefore?: string;
                favorite?: string;
                trash?: string;
                recent?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_drive_items__id_versions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED";
                            id: string;
                            driveItemId: string;
                            versionNumber: number;
                            sizeBytes: number;
                            contentHash: string;
                            /** @constant */
                            contentHashAlgorithm: "SHA256";
                            sourceDeviceId: string | null;
                            createdAt: string;
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_drive_items__id_versions__versionId_restore: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                versionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    baseRevision: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_uploads: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    /** @default null */
                    parentId?: string | null;
                    name: string;
                    sizeBytes: number;
                    /** @default application/octet-stream */
                    mimeType?: string;
                    deviceId?: string | null;
                    contentHash?: string | null;
                    driveItemId?: string;
                    baseRevision?: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        upload: {
                            id: string;
                            /** @enum {string} */
                            state: "CREATED" | "UPLOADING" | "COMPLETING" | "COMPLETED" | "FAILED" | "ABORTED" | "EXPIRED";
                            multipart: boolean;
                            partSizeBytes: number;
                            expectedSizeBytes: number;
                            expiresAt: string;
                            failure?: string;
                            item?: {
                                backupRootId?: string;
                                syncRemovedAt?: string | null;
                                /** @enum {string} */
                                cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                                id: string;
                                ownerUserId: string;
                                parentId: string | null;
                                /** @enum {string} */
                                type: "FILE" | "FOLDER";
                                name: string;
                                normalizedName: string;
                                mimeType: string | null;
                                sizeBytes: number;
                                currentVersionId: string | null;
                                revision: number;
                                favorite: boolean;
                                createdAt: string;
                                updatedAt: string;
                                deletedAt: string | null;
                            };
                        };
                        storage: {
                            quotaBytes: number;
                            usedBytes: number;
                            reservedBytes: number;
                            availableBytes: number;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_uploads__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        upload: {
                            id: string;
                            /** @enum {string} */
                            state: "CREATED" | "UPLOADING" | "COMPLETING" | "COMPLETED" | "FAILED" | "ABORTED" | "EXPIRED";
                            multipart: boolean;
                            partSizeBytes: number;
                            expectedSizeBytes: number;
                            expiresAt: string;
                            failure?: string;
                            item?: {
                                backupRootId?: string;
                                syncRemovedAt?: string | null;
                                /** @enum {string} */
                                cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                                id: string;
                                ownerUserId: string;
                                parentId: string | null;
                                /** @enum {string} */
                                type: "FILE" | "FOLDER";
                                name: string;
                                normalizedName: string;
                                mimeType: string | null;
                                sizeBytes: number;
                                currentVersionId: string | null;
                                revision: number;
                                favorite: boolean;
                                createdAt: string;
                                updatedAt: string;
                                deletedAt: string | null;
                            };
                        };
                        parts: {
                            partNumber: number;
                            etag: string;
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_uploads__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        upload: {
                            id: string;
                            /** @enum {string} */
                            state: "CREATED" | "UPLOADING" | "COMPLETING" | "COMPLETED" | "FAILED" | "ABORTED" | "EXPIRED";
                            multipart: boolean;
                            partSizeBytes: number;
                            expectedSizeBytes: number;
                            expiresAt: string;
                            failure?: string;
                            item?: {
                                backupRootId?: string;
                                syncRemovedAt?: string | null;
                                /** @enum {string} */
                                cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                                id: string;
                                ownerUserId: string;
                                parentId: string | null;
                                /** @enum {string} */
                                type: "FILE" | "FOLDER";
                                name: string;
                                normalizedName: string;
                                mimeType: string | null;
                                sizeBytes: number;
                                currentVersionId: string | null;
                                revision: number;
                                favorite: boolean;
                                createdAt: string;
                                updatedAt: string;
                                deletedAt: string | null;
                            };
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_uploads__id_parts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    partNumbers: number[];
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        parts: {
                            partNumber: number;
                            uploadUrl: string;
                            expiresAt: string;
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_uploads__id_complete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    parts: {
                        partNumber: number;
                        etag: string;
                    }[];
                    contentHash: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_folder_downloads: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    driveItemId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        name: string;
                        /** @enum {string} */
                        state: "QUEUED" | "LISTING" | "BUILDING" | "FINALIZING" | "READY" | "FAILED" | "CANCELLED" | "EXPIRED";
                        files: number;
                        bytes: number;
                        totalFiles: number;
                        totalBytes: number | null;
                        currentFile: string | null;
                        error: string | null;
                        expiresAt: string;
                        downloadUrl?: string;
                        sizeBytes?: number;
                        contentHash?: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_folder_downloads__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        name: string;
                        /** @enum {string} */
                        state: "QUEUED" | "LISTING" | "BUILDING" | "FINALIZING" | "READY" | "FAILED" | "CANCELLED" | "EXPIRED";
                        files: number;
                        bytes: number;
                        totalFiles: number;
                        totalBytes: number | null;
                        currentFile: string | null;
                        error: string | null;
                        expiresAt: string;
                        downloadUrl?: string;
                        sizeBytes?: number;
                        contentHash?: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_folder_downloads__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        cancelled: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_downloads: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    folderDownloadId?: string;
                    driveItemId?: string;
                    versionId?: string | null;
                    transferId?: string;
                    entryId?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        downloadUrl: string;
                        expiresAt: string;
                        sizeBytes: number;
                        contentHash: string;
                        /** @constant */
                        contentHashAlgorithm: "SHA256";
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_transfers: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    recipient: {
                        /** @enum {string} */
                        type: "USERNAME" | "EMAIL";
                        value: string;
                    };
                    items: {
                        driveItemId: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        transfer: {
                            id: string;
                            senderUserId: string;
                            recipientUserId: string | null;
                            recipientEmail: string | null;
                            /** @enum {string} */
                            state: "PENDING_RECIPIENT_SIGNUP" | "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED" | "EXPIRED";
                            createdAt: string;
                            acceptedAt: string | null;
                            declinedAt: string | null;
                            cancelledAt: string | null;
                            expiresAt: string | null;
                            totalSizeBytes: number;
                            savedAt: string | null;
                            displayNames?: string[];
                            /** @enum {string} */
                            preparationState?: "BUILDING" | "READY" | "FAILED";
                            /** @enum {string} */
                            saveState?: "SAVING" | "SAVED" | "FAILED";
                            failure?: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_transfers_received: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                state?: "PENDING_RECIPIENT_SIGNUP" | "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED" | "EXPIRED";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            senderUserId: string;
                            recipientUserId: string | null;
                            recipientEmail: string | null;
                            /** @enum {string} */
                            state: "PENDING_RECIPIENT_SIGNUP" | "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED" | "EXPIRED";
                            createdAt: string;
                            acceptedAt: string | null;
                            declinedAt: string | null;
                            cancelledAt: string | null;
                            expiresAt: string | null;
                            totalSizeBytes: number;
                            savedAt: string | null;
                            displayNames?: string[];
                            /** @enum {string} */
                            preparationState?: "BUILDING" | "READY" | "FAILED";
                            /** @enum {string} */
                            saveState?: "SAVING" | "SAVED" | "FAILED";
                            failure?: string;
                            items: {
                                id: string;
                                sourceDriveItemId: string;
                                sourceVersionId: string | null;
                                displayName: string;
                                relativePath: string;
                                parentEntryId: string | null;
                                /** @enum {string} */
                                itemType: "FILE" | "FOLDER";
                                sizeBytes: number;
                                mimeType: string | null;
                                contentHash: string | null;
                            }[];
                            nextEntryCursor: string | null;
                            sender: {
                                username: string;
                                displayName: string;
                            };
                            recipient: {
                                username: string;
                                displayName: string;
                            } | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_transfers_sent: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            senderUserId: string;
                            recipientUserId: string | null;
                            recipientEmail: string | null;
                            /** @enum {string} */
                            state: "PENDING_RECIPIENT_SIGNUP" | "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED" | "EXPIRED";
                            createdAt: string;
                            acceptedAt: string | null;
                            declinedAt: string | null;
                            cancelledAt: string | null;
                            expiresAt: string | null;
                            totalSizeBytes: number;
                            savedAt: string | null;
                            displayNames?: string[];
                            /** @enum {string} */
                            preparationState?: "BUILDING" | "READY" | "FAILED";
                            /** @enum {string} */
                            saveState?: "SAVING" | "SAVED" | "FAILED";
                            failure?: string;
                            items: {
                                id: string;
                                sourceDriveItemId: string;
                                sourceVersionId: string | null;
                                displayName: string;
                                relativePath: string;
                                parentEntryId: string | null;
                                /** @enum {string} */
                                itemType: "FILE" | "FOLDER";
                                sizeBytes: number;
                                mimeType: string | null;
                                contentHash: string | null;
                            }[];
                            nextEntryCursor: string | null;
                            sender: {
                                username: string;
                                displayName: string;
                            };
                            recipient: {
                                username: string;
                                displayName: string;
                            } | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_transfers__id_accept: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        transfer: {
                            id: string;
                            senderUserId: string;
                            recipientUserId: string | null;
                            recipientEmail: string | null;
                            /** @enum {string} */
                            state: "PENDING_RECIPIENT_SIGNUP" | "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED" | "EXPIRED";
                            createdAt: string;
                            acceptedAt: string | null;
                            declinedAt: string | null;
                            cancelledAt: string | null;
                            expiresAt: string | null;
                            totalSizeBytes: number;
                            savedAt: string | null;
                            displayNames?: string[];
                            /** @enum {string} */
                            preparationState?: "BUILDING" | "READY" | "FAILED";
                            /** @enum {string} */
                            saveState?: "SAVING" | "SAVED" | "FAILED";
                            failure?: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_transfers__id_decline: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        transfer: {
                            id: string;
                            senderUserId: string;
                            recipientUserId: string | null;
                            recipientEmail: string | null;
                            /** @enum {string} */
                            state: "PENDING_RECIPIENT_SIGNUP" | "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED" | "EXPIRED";
                            createdAt: string;
                            acceptedAt: string | null;
                            declinedAt: string | null;
                            cancelledAt: string | null;
                            expiresAt: string | null;
                            totalSizeBytes: number;
                            savedAt: string | null;
                            displayNames?: string[];
                            /** @enum {string} */
                            preparationState?: "BUILDING" | "READY" | "FAILED";
                            /** @enum {string} */
                            saveState?: "SAVING" | "SAVED" | "FAILED";
                            failure?: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_transfers__id_cancel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        transfer: {
                            id: string;
                            senderUserId: string;
                            recipientUserId: string | null;
                            recipientEmail: string | null;
                            /** @enum {string} */
                            state: "PENDING_RECIPIENT_SIGNUP" | "PENDING" | "ACCEPTED" | "DECLINED" | "CANCELLED" | "EXPIRED";
                            createdAt: string;
                            acceptedAt: string | null;
                            declinedAt: string | null;
                            cancelledAt: string | null;
                            expiresAt: string | null;
                            totalSizeBytes: number;
                            savedAt: string | null;
                            displayNames?: string[];
                            /** @enum {string} */
                            preparationState?: "BUILDING" | "READY" | "FAILED";
                            /** @enum {string} */
                            saveState?: "SAVING" | "SAVED" | "FAILED";
                            failure?: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_transfers__id_items: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            sourceDriveItemId: string;
                            sourceVersionId: string | null;
                            displayName: string;
                            relativePath: string;
                            parentEntryId: string | null;
                            /** @enum {string} */
                            itemType: "FILE" | "FOLDER";
                            sizeBytes: number;
                            mimeType: string | null;
                            contentHash: string | null;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_transfers__id_save: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    /** @default null */
                    targetParentId?: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        }[];
                        jobId?: string;
                        state?: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_shares: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    driveItemId: string;
                    recipient: {
                        /** @enum {string} */
                        type: "USERNAME" | "EMAIL";
                        value: string;
                    };
                    /** @enum {string} */
                    permission: "VIEWER" | "EDITOR";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        share: {
                            /** @enum {string} */
                            syncState?: "PENDING" | "ACCEPTED" | "DECLINED";
                            id: string;
                            driveItemId: string;
                            ownerUserId: string;
                            recipientUserId: string;
                            /** @enum {string} */
                            permission: "VIEWER" | "EDITOR";
                            createdAt: string;
                            revokedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_shares__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        share: {
                            /** @enum {string} */
                            syncState?: "PENDING" | "ACCEPTED" | "DECLINED";
                            id: string;
                            driveItemId: string;
                            ownerUserId: string;
                            recipientUserId: string;
                            /** @enum {string} */
                            permission: "VIEWER" | "EDITOR";
                            createdAt: string;
                            revokedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_shares_received: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @enum {string} */
                            syncState?: "PENDING" | "ACCEPTED" | "DECLINED";
                            id: string;
                            driveItemId: string;
                            ownerUserId: string;
                            recipientUserId: string;
                            /** @enum {string} */
                            permission: "VIEWER" | "EDITOR";
                            createdAt: string;
                            revokedAt: string | null;
                            item: {
                                backupRootId?: string;
                                syncRemovedAt?: string | null;
                                /** @enum {string} */
                                cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                                id: string;
                                ownerUserId: string;
                                parentId: string | null;
                                /** @enum {string} */
                                type: "FILE" | "FOLDER";
                                name: string;
                                normalizedName: string;
                                mimeType: string | null;
                                sizeBytes: number;
                                currentVersionId: string | null;
                                revision: number;
                                favorite: boolean;
                                createdAt: string;
                                updatedAt: string;
                                deletedAt: string | null;
                            };
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_shares_sent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @enum {string} */
                            syncState?: "PENDING" | "ACCEPTED" | "DECLINED";
                            id: string;
                            driveItemId: string;
                            ownerUserId: string;
                            recipientUserId: string;
                            /** @enum {string} */
                            permission: "VIEWER" | "EDITOR";
                            createdAt: string;
                            revokedAt: string | null;
                            item: {
                                backupRootId?: string;
                                syncRemovedAt?: string | null;
                                /** @enum {string} */
                                cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                                id: string;
                                ownerUserId: string;
                                parentId: string | null;
                                /** @enum {string} */
                                type: "FILE" | "FOLDER";
                                name: string;
                                normalizedName: string;
                                mimeType: string | null;
                                sizeBytes: number;
                                currentVersionId: string | null;
                                revision: number;
                                favorite: boolean;
                                createdAt: string;
                                updatedAt: string;
                                deletedAt: string | null;
                            };
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_devices: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            userId: string;
                            name: string;
                            /** @enum {string} */
                            platform: "WEB" | "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID";
                            appVersion: string | null;
                            devicePublicId: string | null;
                            /** @default null */
                            keyFingerprint: string | null;
                            lastSeenAt: string | null;
                            createdAt: string;
                            revokedAt: string | null;
                            /** @enum {string} */
                            status?: "ACTIVE" | "SIGNED_OUT" | "REVOKED";
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_sync_devices_register: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    /** @enum {string} */
                    platform: "WEB" | "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID";
                    devicePublicId?: string;
                    appVersion?: string;
                    proof?: {
                        publicKey: string;
                        challenge: string;
                        signature: string;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        device: {
                            id: string;
                            userId: string;
                            name: string;
                            /** @enum {string} */
                            platform: "WEB" | "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID";
                            appVersion: string | null;
                            devicePublicId: string | null;
                            /** @default null */
                            keyFingerprint: string | null;
                            lastSeenAt: string | null;
                            createdAt: string;
                            revokedAt: string | null;
                            /** @enum {string} */
                            status?: "ACTIVE" | "SIGNED_OUT" | "REVOKED";
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    put__v1_devices_current_push: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    token: string;
                    /** @enum {string} */
                    environment: "sandbox" | "production";
                    /** @constant */
                    kind: "FILE_PROVIDER";
                    domain: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        registered: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_devices_current_push: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        removed: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_devices__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        device: {
                            id: string;
                            userId: string;
                            name: string;
                            /** @enum {string} */
                            platform: "WEB" | "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID";
                            appVersion: string | null;
                            devicePublicId: string | null;
                            /** @default null */
                            keyFingerprint: string | null;
                            lastSeenAt: string | null;
                            createdAt: string;
                            revokedAt: string | null;
                            /** @enum {string} */
                            status?: "ACTIVE" | "SIGNED_OUT" | "REVOKED";
                        };
                        archivedBackups: number;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_devices__id_sign_out: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        device: {
                            id: string;
                            userId: string;
                            name: string;
                            /** @enum {string} */
                            platform: "WEB" | "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID";
                            appVersion: string | null;
                            devicePublicId: string | null;
                            /** @default null */
                            keyFingerprint: string | null;
                            lastSeenAt: string | null;
                            createdAt: string;
                            revokedAt: string | null;
                            /** @enum {string} */
                            status?: "ACTIVE" | "SIGNED_OUT" | "REVOKED";
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_sync_shares: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @enum {string} */
                            syncState?: "PENDING" | "ACCEPTED" | "DECLINED";
                            id: string;
                            driveItemId: string;
                            ownerUserId: string;
                            recipientUserId: string;
                            /** @enum {string} */
                            permission: "VIEWER" | "EDITOR";
                            createdAt: string;
                            revokedAt: string | null;
                            name: string;
                            /** @enum {string} */
                            direction: "SENT" | "RECEIVED";
                            owner: {
                                id: string;
                                username: string;
                                displayName: string;
                            };
                            recipient: {
                                id: string;
                                username: string;
                                displayName: string;
                            };
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_sync_shares: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    driveItemId: string;
                    recipient: {
                        /** @enum {string} */
                        type: "USERNAME" | "EMAIL";
                        value: string;
                    };
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        share: {
                            /** @enum {string} */
                            syncState?: "PENDING" | "ACCEPTED" | "DECLINED";
                            id: string;
                            driveItemId: string;
                            ownerUserId: string;
                            recipientUserId: string;
                            /** @enum {string} */
                            permission: "VIEWER" | "EDITOR";
                            createdAt: string;
                            revokedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_sync_shares__id_respond: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action: "ACCEPTED" | "DECLINED";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        share: {
                            /** @enum {string} */
                            syncState?: "PENDING" | "ACCEPTED" | "DECLINED";
                            id: string;
                            driveItemId: string;
                            ownerUserId: string;
                            recipientUserId: string;
                            /** @enum {string} */
                            permission: "VIEWER" | "EDITOR";
                            createdAt: string;
                            revokedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_sync_shares__id_status: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        share: {
                            /** @enum {string} */
                            syncState?: "PENDING" | "ACCEPTED" | "DECLINED";
                            id: string;
                            driveItemId: string;
                            ownerUserId: string;
                            recipientUserId: string;
                            /** @enum {string} */
                            permission: "VIEWER" | "EDITOR";
                            createdAt: string;
                            revokedAt: string | null;
                        };
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                        sequence: number;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_realtime_tickets: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        url: string;
                        ticket: string;
                        expiresAt: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_sync_folders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                            syncDevices: {
                                id: string;
                                name: string;
                            }[];
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    put__v1_sync_folders: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    folderIds: string[];
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ok: boolean;
                        removedFolderIds: string[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_sync_folders__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ok: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_drive_usage: {
        parameters: {
            query?: {
                ids?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            itemId: string;
                            bytes: number;
                            files: number;
                            complete: boolean;
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_sync_status: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            itemId: string;
                            revision?: number;
                            deviceConfirmed?: boolean;
                            /** @enum {string} */
                            state: "PENDING" | "SYNCING" | "SYNCED" | "UNKNOWN";
                            requiredDevices: number;
                            confirmedDevices: number;
                            /** @enum {string} */
                            cloudState: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            pendingItems: number;
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_sync_items__id_acknowledge: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    versionId: string | null;
                    revision: number;
                    contentHash: string | null;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ok: boolean;
                        requiredDevices: number;
                        confirmedDevices: number;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_sync_items__id_request_content: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_sync_changes: {
        parameters: {
            query?: {
                cursor?: number;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        changes: {
                            sequence: number;
                            type: string;
                            entityId: string;
                            revision: number | null;
                            occurredAt: string;
                            item?: {
                                backupRootId?: string;
                                syncRemovedAt?: string | null;
                                /** @enum {string} */
                                cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                                id: string;
                                ownerUserId: string;
                                parentId: string | null;
                                /** @enum {string} */
                                type: "FILE" | "FOLDER";
                                name: string;
                                normalizedName: string;
                                mimeType: string | null;
                                sizeBytes: number;
                                currentVersionId: string | null;
                                revision: number;
                                favorite: boolean;
                                createdAt: string;
                                updatedAt: string;
                                deletedAt: string | null;
                            };
                        }[];
                        nextCursor: number;
                        hasMore: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_sync_checkpoints: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    deviceId: string;
                    cursor: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        cursor: number;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_sync_operations: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    deviceId: string;
                    operations: {
                        /** Format: uuid */
                        operationId: string;
                        /** @enum {string} */
                        type: "RENAME_ITEM" | "MOVE_ITEM" | "DELETE_ITEM" | "RESTORE_ITEM";
                        entityId: string;
                        baseRevision: number;
                        payload: {
                            name?: string;
                            parentId?: string | null;
                        };
                    }[];
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        results: {
                            operationId: string;
                            /** @enum {string} */
                            status: "APPLIED" | "ALREADY_APPLIED" | "CONFLICT" | "REJECTED";
                            revision?: number;
                            serverItem?: {
                                backupRootId?: string;
                                syncRemovedAt?: string | null;
                                /** @enum {string} */
                                cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                                id: string;
                                ownerUserId: string;
                                parentId: string | null;
                                /** @enum {string} */
                                type: "FILE" | "FOLDER";
                                name: string;
                                normalizedName: string;
                                mimeType: string | null;
                                sizeBytes: number;
                                currentVersionId: string | null;
                                revision: number;
                                favorite: boolean;
                                createdAt: string;
                                updatedAt: string;
                                deletedAt: string | null;
                            };
                            serverRevision?: number;
                            error?: {
                                code: string;
                                message: string;
                            };
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_notifications: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            type: string;
                            data: {
                                [key: string]: unknown;
                            };
                            readAt: string | null;
                            createdAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_notifications__id_read: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        notification: {
                            id: string;
                            type: string;
                            data: {
                                [key: string]: unknown;
                            };
                            readAt: string | null;
                            createdAt: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_backups: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            userId: string;
                            deviceId: string;
                            deviceName?: string;
                            devicePublicId?: string | null;
                            localPathDisplayName: string;
                            remoteRootDriveItemId: string;
                            /** @enum {string} */
                            state: "ACTIVE" | "PAUSED" | "ERROR" | "ARCHIVED" | "REMOVED";
                            createdAt: string;
                            updatedAt: string;
                        }[];
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    deviceId: string;
                    name: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        root: {
                            id: string;
                            userId: string;
                            deviceId: string;
                            deviceName?: string;
                            devicePublicId?: string | null;
                            localPathDisplayName: string;
                            remoteRootDriveItemId: string;
                            /** @enum {string} */
                            state: "ACTIVE" | "PAUSED" | "ERROR" | "ARCHIVED" | "REMOVED";
                            createdAt: string;
                            updatedAt: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_backups__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        root: {
                            id: string;
                            userId: string;
                            deviceId: string;
                            deviceName?: string;
                            devicePublicId?: string | null;
                            localPathDisplayName: string;
                            remoteRootDriveItemId: string;
                            /** @enum {string} */
                            state: "ACTIVE" | "PAUSED" | "ERROR" | "ARCHIVED" | "REMOVED";
                            createdAt: string;
                            updatedAt: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    delete__v1_backups__id: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        root: {
                            id: string;
                            userId: string;
                            deviceId: string;
                            deviceName?: string;
                            devicePublicId?: string | null;
                            localPathDisplayName: string;
                            remoteRootDriveItemId: string;
                            /** @enum {string} */
                            state: "ACTIVE" | "PAUSED" | "ERROR" | "ARCHIVED" | "REMOVED";
                            createdAt: string;
                            updatedAt: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_forget: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        removed: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_archive: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        root: {
                            id: string;
                            userId: string;
                            deviceId: string;
                            deviceName?: string;
                            devicePublicId?: string | null;
                            localPathDisplayName: string;
                            remoteRootDriveItemId: string;
                            /** @enum {string} */
                            state: "ACTIVE" | "PAUSED" | "ERROR" | "ARCHIVED" | "REMOVED";
                            createdAt: string;
                            updatedAt: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_unarchive: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        root: {
                            id: string;
                            userId: string;
                            deviceId: string;
                            deviceName?: string;
                            devicePublicId?: string | null;
                            localPathDisplayName: string;
                            remoteRootDriveItemId: string;
                            /** @enum {string} */
                            state: "ACTIVE" | "PAUSED" | "ERROR" | "ARCHIVED" | "REMOVED";
                            createdAt: string;
                            updatedAt: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_runs__runId_folders: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                runId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    /** @default null */
                    parentId?: string | null;
                    name: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        item: {
                            backupRootId?: string;
                            syncRemovedAt?: string | null;
                            /** @enum {string} */
                            cloudState?: "AVAILABLE" | "RELEASED" | "REQUESTED";
                            id: string;
                            ownerUserId: string;
                            parentId: string | null;
                            /** @enum {string} */
                            type: "FILE" | "FOLDER";
                            name: string;
                            normalizedName: string;
                            mimeType: string | null;
                            sizeBytes: number;
                            currentVersionId: string | null;
                            revision: number;
                            favorite: boolean;
                            createdAt: string;
                            updatedAt: string;
                            deletedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_runs__runId_uploads: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                runId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    operationId: string;
                    /** @default null */
                    parentId?: string | null;
                    name: string;
                    sizeBytes: number;
                    /** @default application/octet-stream */
                    mimeType?: string;
                    deviceId?: string | null;
                    contentHash?: string | null;
                    driveItemId?: string;
                    baseRevision?: number;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_backups__id_runs: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            rootId: string;
                            deviceId: string;
                            /** @enum {string} */
                            trigger: "AUTOMATIC" | "MANUAL";
                            /** @enum {string} */
                            state: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
                            startedAt: string;
                            completedAt: string | null;
                            fileCount: number;
                            sizeBytes: number;
                            error?: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_runs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    id: string;
                    /** @enum {string} */
                    trigger: "AUTOMATIC" | "MANUAL";
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        run: {
                            id: string;
                            rootId: string;
                            deviceId: string;
                            /** @enum {string} */
                            trigger: "AUTOMATIC" | "MANUAL";
                            /** @enum {string} */
                            state: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
                            startedAt: string;
                            completedAt: string | null;
                            fileCount: number;
                            sizeBytes: number;
                            error?: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_backups__id_restores: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            rootId: string;
                            itemId: string;
                            versionId: string;
                            relativePath: string;
                            /** @enum {string} */
                            state: "PENDING" | "COMPLETED" | "FAILED";
                            requestedAt: string;
                            completedAt: string | null;
                            error?: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_restores: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    id: string;
                    itemId: string;
                    versionId: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        restore: {
                            id: string;
                            rootId: string;
                            itemId: string;
                            versionId: string;
                            relativePath: string;
                            /** @enum {string} */
                            state: "PENDING" | "COMPLETED" | "FAILED";
                            requestedAt: string;
                            completedAt: string | null;
                            error?: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_backups__id_pending_restores: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            rootId: string;
                            itemId: string;
                            versionId: string;
                            relativePath: string;
                            /** @enum {string} */
                            state: "PENDING" | "COMPLETED" | "FAILED";
                            requestedAt: string;
                            completedAt: string | null;
                            error?: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_backups__id_runs__runId_files: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                id: string;
                runId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            relativePath: string;
                            itemId: string;
                            versionId: string;
                            sizeBytes: number;
                            modifiedAt: string;
                            savedAt: string;
                        }[];
                        nextCursor: string | null;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_runs__runId_files: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                runId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    relativePath: string;
                    itemId: string;
                    versionId: string;
                    sizeBytes: number;
                    modifiedAt: string;
                    savedAt: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_runs__runId_complete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                runId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    error?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        run: {
                            id: string;
                            rootId: string;
                            deviceId: string;
                            /** @enum {string} */
                            trigger: "AUTOMATIC" | "MANUAL";
                            /** @enum {string} */
                            state: "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";
                            startedAt: string;
                            completedAt: string | null;
                            fileCount: number;
                            sizeBytes: number;
                            error?: string;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    post__v1_backups__id_restores__restoreId_complete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                restoreId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    error?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_billing_plans: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            name: string;
                            storageBytes: number;
                            priceMinorUnits: number;
                            currency: string;
                            /** @enum {string} */
                            billingPeriod: "MONTH" | "YEAR";
                        }[];
                        checkoutAvailable: boolean;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__v1_billing_subscription: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        planId: string;
                        entitlement: {
                            userId: string;
                            baseFreeBytes: number;
                            paidBytes: number;
                            totalQuotaBytes: number;
                        };
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
    get__ready: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        status: string;
                    };
                };
            };
            /** @description Error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
            /** @description Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            code: string;
                            message: string;
                            requestId: string;
                            details?: unknown;
                        };
                    };
                };
            };
        };
    };
}
