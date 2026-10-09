import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminResetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { readOutputs } from '../infra/environment';
// Manages console staff in the staff pool. Run with AWS credentials for the harbor0 account:
//   npm run admin:staff -- list
//   npm run admin:staff -- add someone@harbor0.com support|admin
//   npm run admin:staff -- role someone@harbor0.com admin|support
//   npm run admin:staff -- disable|enable someone@harbor0.com
const outputs = await readOutputs('storage');
const UserPoolId: string = outputs.StaffUserPoolId;
if (!UserPoolId)
  throw new Error('No StaffUserPoolId in the storage outputs; deploy the storage stack first.');
const client = new CognitoIdentityProviderClient({});
const [command, email, role] = process.argv.slice(2);
const roles = ['admin', 'support'];
const Username = email?.toLowerCase();
const need = (ok: unknown, usage: string) => {
  if (!ok) {
    console.error(`Usage: npm run admin:staff -- ${usage}`);
    process.exit(1);
  }
};
async function setRole(name: string) {
  for (const group of roles)
    if (group !== name)
      await client
        .send(new AdminRemoveUserFromGroupCommand({ UserPoolId, Username, GroupName: group }))
        .catch(() => undefined);
  await client.send(new AdminAddUserToGroupCommand({ UserPoolId, Username, GroupName: name }));
}
switch (command) {
  case 'list': {
    const { Users = [] } = await client.send(new ListUsersCommand({ UserPoolId, Limit: 60 }));
    for (const user of Users) {
      const mail = user.Attributes?.find((a) => a.Name === 'email')?.Value;
      const { Groups = [] } = await client.send(
        new AdminListGroupsForUserCommand({ UserPoolId, Username: user.Username }),
      );
      console.log(
        `${mail}\t${Groups.map((g) => g.GroupName).join(',') || '(no role)'}\t${user.UserStatus}${user.Enabled ? '' : '\tDISABLED'}`,
      );
    }
    break;
  }
  case 'add':
    need(Username && roles.includes(role), 'add <email> admin|support');
    // Cognito emails a temporary password; first sign-in sets a password and an authenticator.
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username,
        UserAttributes: [
          { Name: 'email', Value: Username },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    await setRole(role);
    console.log(`Invited ${Username} as ${role}.`);
    break;
  case 'role':
    need(Username && roles.includes(role), 'role <email> admin|support');
    await setRole(role);
    await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId, Username }));
    console.log(`${Username} is now ${role}; their console sessions were ended.`);
    break;
  case 'disable':
  case 'enable':
    need(Username, `${command} <email>`);
    await client.send(
      command === 'disable'
        ? new AdminDisableUserCommand({ UserPoolId, Username })
        : new AdminEnableUserCommand({ UserPoolId, Username }),
    );
    if (command === 'disable')
      await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId, Username }));
    console.log(`${Username} ${command}d.`);
    break;
  case 'reset-password':
    need(Username, 'reset-password <email>');
    await client.send(new AdminResetUserPasswordCommand({ UserPoolId, Username }));
    console.log(`Reset the password of ${Username}.`);
    break;
  default:
    need(false, 'list | add | role | disable | enable | reset-password');
}
