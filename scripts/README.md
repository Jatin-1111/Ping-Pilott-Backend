# Admin Account Creation Script

## Usage

Run this script to create an admin account:

```bash
node scripts/createAdmin.js
```

## What it does

1. Connects to MongoDB using your `.env` configuration
2. Prompts you for:
   - Admin email
   - Admin password (minimum 6 characters)
   - Display name (optional)
3. Creates an admin user with:
   - Full admin privileges
   - Email verified
   - Unlimited plan
   - All premium features enabled

## Features

- **Interactive**: Prompts for input
- **Safe**: Checks if user already exists
- **Flexible**: Can upgrade existing users to admin
- **Validated**: Ensures email and password meet requirements

## Example

```
$ node scripts/createAdmin.js

🚀 Admin Account Creation Script

📡 Connecting to MongoDB...
✅ Connected to MongoDB

Enter admin email: admin@example.com
Enter admin password (min 6 characters): ******
Enter admin display name (optional): Admin User

✅ Admin account created successfully!
📧 Email: admin@example.com
👤 Name: Admin User
🔑 Role: admin
📦 Plan: admin
✉️  Email Verified: true

📡 MongoDB connection closed.
```

## Notes

- The script will automatically close MongoDB connection when done
- If a user with the email already exists, you'll be asked if you want to upgrade them to admin
- Password is hashed automatically by the User model
