# Woosh Lifts Admin UI

A simple, lightweight admin interface for managing lifts, contacts, and viewing messages in the Woosh Lifts system.

## Features

- **Resolve Lift by MSISDN** - Shows/creates lift records with inline editing
- **Contact Management** - Add, edit, and link contacts to lifts
- **Message History** - View recent messages for each lift
- **Real-time Status** - Shows system health and database connectivity
- **Responsive Design** - Works on desktop and mobile devices

## Local Testing

To test the admin UI locally against the production API:

1. Open `admin/admin.html` in your browser
2. The UI is pre-configured to use the production service URL: `https://woosh-lifts-oqodqtnlma-bq.a.run.app`

### Changing the Base URL

If you need to test against a different environment, edit the `BASE_URL` constant in the JavaScript section:

```javascript
const BASE_URL = 'https://your-custom-url.a.run.app';
```

## Deployment to Google Cloud Storage

Deploy the admin UI as a static website using Google Cloud Storage:

### Prerequisites

- Google Cloud SDK installed and configured
- Access to the `woosh-lifts-20250924-072759` project
- `gsutil` command available

### Deployment Commands

```bash
# Set variables
PROJECT_ID="woosh-lifts-20250924-072759"
BUCKET="woosh-lifts-admin-$PROJECT_ID"

# Create bucket
gsutil mb -p "$PROJECT_ID" -l africa-south1 "gs://$BUCKET/"

# Upload admin.html as index.html
gsutil cp admin/admin.html "gs://$BUCKET/index.html"

# Make bucket publicly readable
gsutil iam ch allUsers:objectViewer "gs://$BUCKET"

# Configure as website
gsutil web set -m index.html "gs://$BUCKET"

# Display the public URL
echo "Admin UI available at: https://storage.googleapis.com/$BUCKET/index.html"
```

The admin UI will be available at:
**https://storage.googleapis.com/woosh-lifts-admin-woosh-lifts-20250924-072759/index.html**

## Usage Guide

### 1. Resolve a Lift

1. Enter a mobile number (MSISDN) in the search field (e.g., `27824537125`)
2. Click "Resolve Lift" or press Enter
3. The system will find or create the lift record
4. Edit the lift information (site name, building, notes) and click "Save Lift"

### 2. Manage Contacts

1. After resolving a lift, switch to the "Contacts" tab
2. View existing contacts linked to the lift
3. Add a new contact:
   - Fill in the contact details (name, MSISDN, email, role)
   - Set the relation to the lift (e.g., "security", "tenant", "manager")
   - Click "Add/Update Contact & Link"
4. Unlink contacts using the "Unlink" button

### 3. View Messages

1. Switch to the "Messages" tab
2. View recent messages for the lift
3. Messages show direction (inbound/outbound), timestamp, and content

### 4. Monitor System Status

- The status pill in the top-right corner shows:
  - **Green**: System online and database connected
  - **Red**: System offline or database issues

## API Endpoints Used

The admin UI interacts with these existing API endpoints:

- `GET /admin/status` - System health check
- `GET /admin/resolve/lift?msisdn=...` - Resolve lift by MSISDN
- `POST /admin/lifts` - Create/update lift information
- `GET /admin/lifts/:id/contacts` - Get contacts for a lift
- `POST /admin/lifts/:id/contacts` - Link contact to lift
- `DELETE /admin/lifts/:id/contacts/:contactId` - Unlink contact from lift
- `POST /admin/contacts` - Create/update contact
- `GET /admin/messages?lift_id=...` - Get messages for a lift

## Security Considerations

- The admin UI uses CORS to communicate with the production API
- All API endpoints are already CORS-enabled for `/admin/*` routes
- The UI makes direct requests to the production service
- No authentication is implemented in this MVP version

## Browser Compatibility

- Modern browsers with ES6+ support
- Chrome, Firefox, Safari, Edge (recent versions)
- Mobile responsive design

## Troubleshooting

### CORS Issues

If you encounter CORS errors:
1. Verify the service URL is correct
2. Check that the production service is running
3. Ensure the API endpoints are accessible

### API Errors

Common error scenarios:
- **404 Not Found**: Lift or contact doesn't exist
- **400 Bad Request**: Invalid data format
- **500 Server Error**: Backend issue (check service logs)

### Status Check

If the status pill shows "Offline":
1. Verify the production service is running
2. Check `/admin/status` endpoint manually
3. Ensure database connectivity

## Development Notes

- Single-file HTML with embedded CSS and JavaScript
- No build process required
- Vanilla JavaScript (no frameworks)
- Responsive CSS Grid and Flexbox layout
- Clean, minimal design following modern UI patterns

## Future Enhancements

Potential improvements for future versions:
- Authentication/authorization
- Bulk operations
- Advanced filtering and search
- Export functionality
- Real-time updates
- Audit logging
