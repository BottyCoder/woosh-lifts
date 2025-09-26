# Woosh WhatsApp Bridge API Specification

**Version**: 1.0  
**Date**: 2025-01-XX  
**Contact**: Woosh WA Team  

---

## Overview

The Woosh WhatsApp Bridge API provides a simple, reliable interface for sending WhatsApp messages through our production infrastructure. This API handles authentication, message formatting, and delivery to WhatsApp's Cloud API.

---

## Environment & Authentication

### Production Environment
- **Base URL**: `https://wa.woosh.ai`
- **Authentication**: API Key via `X-Api-Key` header
- **Content-Type**: `application/json`
- **IP Allowlisting**: Not required (supports dynamic IPs)

### API Key Provisioning
- Contact Woosh WA team for API key generation
- Single key per service/project
- Keys are environment-specific (production/staging)

---

## Send API Contract

### Endpoint
```
POST /api/messages/send
```

### Headers
```
Content-Type: application/json
X-Api-Key: <your_api_key>
```

### Request Schema

#### Basic Text Message
```json
{
  "to": "27824537125",
  "text": "Your message here"
}
```

#### Interactive Button Message
```json
{
  "to": "27824537125",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": {
      "text": "Choose an option:"
    },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": {
            "id": "option_1",
            "title": "Option 1"
          }
        },
        {
          "type": "reply", 
          "reply": {
            "id": "option_2",
            "title": "Option 2"
          }
        }
      ]
    }
  }
}
```

#### PDF Document (File Upload)
```json
{
  "to": "27824537125",
  "document": {
    "pdf": "base64_encoded_pdf_content",
    "filename": "document.pdf",
    "caption": "Your document"
  }
}
```

#### Template Message
```json
{
  "to": "27824537125",
  "type": "template",
  "template": {
    "name": "template_name",
    "language": {
      "code": "en"
    },
    "components": [
      {
        "type": "body",
        "parameters": [
          {
            "type": "text",
            "text": "parameter_value"
          }
        ]
      }
    ]
  }
}
```

### Field Specifications

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | E.164 phone number (with or without +) |
| `text` | string | No* | Message text (max 4096 chars, UTF-8) |
| `type` | string | No | Message type: "interactive", "template", "document" |
| `interactive` | object | No | Interactive message payload |
| `document` | object | No | Document payload |
| `template` | object | No | Template message payload |

*Required for text messages, not for other types

---

## Response Format

### Success Response
```json
{
  "ok": true,
  "wa_id": "wamid.xxx",
  "to": "27824537125",
  "accepted": true
}
```

### Error Response
```json
{
  "ok": false,
  "error": "error_code",
  "message": "Human readable error description"
}
```

### Common Error Codes

| Code | HTTP Status | Description | Retryable |
|------|-------------|-------------|-----------|
| `invalid_api_key` | 401 | Invalid or missing API key | No |
| `invalid_phone` | 400 | Invalid phone number format | No |
| `message_too_long` | 400 | Message exceeds length limit | No |
| `rate_limited` | 429 | Rate limit exceeded | Yes |
| `template_not_found` | 400 | Template not approved/available | No |
| `unsupported_payload` | 400 | Invalid message format | No |
| `server_error` | 500 | Internal server error | Yes |

---

## Rate Limits & Constraints

### Rate Limits
- **Throughput**: 100 messages/minute per API key
- **Burst**: 10 messages/second
- **Timeout**: 30 seconds recommended client timeout

### Message Constraints
- **Text Length**: Maximum 4096 characters
- **Phone Format**: E.164 format (e.g., "27824537125" or "+27824537125")
- **Unicode**: Full UTF-8 support including emojis and RTL languages
- **Media**: PDF documents up to 100MB (base64 encoded)

### WhatsApp Policy Constraints

#### 24-Hour Session Rules
- **Within 24h**: Free-form text messages allowed
- **Outside 24h**: Template messages required
- **Session Reset**: New customer-initiated message resets 24h window

#### Template Requirements
- Templates must be pre-approved by WhatsApp
- Use approved template names only
- Include required parameters in components
- Support multiple languages via language codes

---

## Status Callbacks (Optional)

### Callback Endpoint
If you want delivery status updates, expose:
```
POST /wa/status
```

### Callback Payload
```json
{
  "wa_id": "wamid.xxx",
  "to": "27824537125", 
  "status": "delivered",
  "timestamp": "2025-01-XXT10:30:00Z"
}
```

### Status Values
- `sent` - Message sent to WhatsApp
- `delivered` - Message delivered to device
- `read` - Message read by recipient
- `failed` - Message delivery failed

### Callback Headers
```
Content-Type: application/json
X-Hub-Signature-256: sha256=<signature>
```

### Retry Policy
- **Attempts**: 3 retries
- **Backoff**: Exponential (1s, 2s, 4s)
- **Timeout**: 5 seconds per attempt

---

## Test Plan

### Test Environment
- **Test Number**: `27824537125` (verified WhatsApp number)
- **Test Message**: 
  ```json
  {
    "to": "27824537125",
    "text": "Test message from woosh-lifts integration"
  }
  ```

### Expected Response
```json
{
  "ok": true,
  "wa_id": "wamid.xxx",
  "to": "27824537125",
  "accepted": true
}
```

### End-to-End Test
1. Send test message to verified number
2. Verify response contains `wa_id`
3. Confirm message received on WhatsApp
4. Test error scenarios (invalid phone, rate limits)

---

## Operational Details

### SLA/SLO
- **Uptime**: 99.9% availability
- **Response Time**: <2 seconds average
- **Maintenance**: Scheduled during low-traffic hours
- **Status Page**: Available upon request

### Escalation
- **Incidents**: Contact via PROJECT-BRIEF.md admin channels
- **Support**: 24/7 monitoring and response
- **Updates**: Real-time status notifications

### Security
- **HTTPS**: All communications encrypted
- **API Keys**: Rotate every 90 days
- **Logging**: Full audit trail (secrets redacted)
- **Compliance**: GDPR and data protection compliant

---

## Integration Examples

### cURL Example
```bash
curl -X POST "https://wa.woosh.ai/api/messages/send" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: your_api_key_here" \
  -d '{
    "to": "27824537125",
    "text": "Hello from woosh-lifts!"
  }'
```

### Node.js Example
```javascript
const fetch = require('node-fetch');

const sendMessage = async (to, text) => {
  const response = await fetch('https://wa.woosh.ai/api/messages/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.BRIDGE_API_KEY
    },
    body: JSON.stringify({ to, text })
  });
  
  return await response.json();
};
```

### Python Example
```python
import requests

def send_message(to, text):
    url = "https://wa.woosh.ai/api/messages/send"
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": "your_api_key_here"
    }
    payload = {"to": to, "text": text}
    
    response = requests.post(url, json=payload, headers=headers)
    return response.json()
```

---

## Support & Documentation

- **API Documentation**: This specification
- **Integration Guide**: PROJECT-BRIEF.md
- **Status Page**: Available upon request
- **Support**: Contact Woosh WA team

---

**Last Updated**: 2025-01-XX  
**Version**: 1.0  
**Contact**: Woosh WA Team
