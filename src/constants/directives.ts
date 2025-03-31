export const DirectiveDescriptions = {
    '@host': 'Define the host URL for the request\n\n```\n@host https://api.example.com\n```',
    '@name': 'Set a name for the test case\n\n```\n@name Get User Profile\n```',
    '@description': 'Add a description for the test case\n\n```\n@description Tests the user profile endpoint with valid credentials\n```',
    '@auth': 'Specify authentication settings\n\n```\n@auth {"type": "bearer", "token": "{{token}}"}\n```',
    '@headers': 'Define common headers for requests\n\n```\n@headers {"Accept": "application/json", "X-API-Key": "{{apiKey}}"}\n```',
    '@variables': 'Define variables for the test case\n\n```\n@variables {"userId": "123", "apiKey": "xyz789"}\n```',
    'TEST-EXPECT-STATUS': 'Expected HTTP status code(s) for the response\n\n```\n## TEST-EXPECT-STATUS: [200]\n## TEST-EXPECT-STATUS: [200, 201]\n```',
    'TEST-HAS-BODY': 'Verifies that the response has a body\n\n```\n## TEST-HAS-BODY: true\n```',
    'TEST-HAS-HEADER': 'Verifies that the response contains the specified header\n\n```\n## TEST-HAS-HEADER: ["Content-Type"]\n## TEST-HAS-HEADER: ["Content-Type", "ETag"]\n```',
    'TEST-SUCCESSFUL-STATUS': 'Verifies that the response has a successful status code (2xx)\n\n```\n## TEST-SUCCESSFUL-STATUS: true\n```',
    'RETRY-STRATEGY': 'Defines the retry strategy for failed requests\n\n```\n## RETRY-STRATEGY: DefaultRetry\n## RETRY-STRATEGY: CustomRetry\n```',
    'RETRY-MAX-ATTEMPTS': 'Maximum number of retry attempts\n\n```\n## RETRY-MAX-ATTEMPTS: 3\n```',
    'RETRY-BACKOFF-TYPE': 'Type of delay between retries (Linear, Exponential)\n\n```\n## RETRY-BACKOFF-TYPE: Linear\n## RETRY-BACKOFF-TYPE: Exponential\n```',
    'RETRY-MAX-DELAY': 'Maximum delay between retries\n\n```\n## RETRY-MAX-DELAY: 5000\n```',
    'RETRY-UNTIL-STATUS': 'Retry until response matches specified status code(s)\n\n```\n## RETRY-UNTIL-STATUS: 200\n## RETRY-UNTIL-STATUS: [200, 201]\n```',
    'AUTH-PROVIDER': 'Specifies the authentication provider to use for this request\n\n```\n## AUTH-PROVIDER: OAuth2\n## AUTH-PROVIDER: CustomAuth\n```'
} as const; 