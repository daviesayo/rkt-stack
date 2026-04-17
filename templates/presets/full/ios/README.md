# iOS app

Xcode does not have a CLI for creating new iOS app projects, so this folder
is intentionally empty. To finish the setup:

1. Open Xcode → **Create New Project**
2. Choose **iOS → App**, Interface: **SwiftUI**, Language: **Swift**
3. Product Name: `{{PROJECT_NAME_PASCAL}}`
4. Organization Identifier: use your preferred reverse-domain
5. Save location: this `ios/` folder
6. Enable relevant Capabilities (Push Notifications, App Groups, etc.)

Commit the resulting `{{PROJECT_NAME_PASCAL}}.xcodeproj` and source tree.

After that, `/implement` can do real iOS work.
