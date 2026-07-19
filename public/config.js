// Runtime configuration for the Fair Seat Purchase UI.
//
// FSP_API_BASE is the base URL of the API.
//   - Empty string  -> same-origin (local `npm start`, where the Express server
//                       serves both this UI and the API).
//   - An API Gateway URL -> used when the UI is hosted separately (e.g. on
//                       S3 + CloudFront). The CDK deployment overwrites this
//                       file in the S3 bucket with the real API endpoint.
window.FSP_API_BASE = "";
