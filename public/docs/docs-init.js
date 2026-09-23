async function loadDocs() {
  const response = await fetch('/openapi.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('OpenAPI description unavailable.');
  const spec = await response.json();
  // The interactive page always tests the API host that served the page.
  spec.servers = [{ url: window.location.origin, description: 'This API host' }];
  SwaggerUIBundle({
    spec,
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'list',
    filter: true,
    tryItOutEnabled: true,
    supportedSubmitMethods: ['get', 'post'],
    displayRequestDuration: true,
    persistAuthorization: false,
    validatorUrl: null,
  });
}

loadDocs().catch(() => {
  document.getElementById('swagger-ui').textContent = 'API documentation could not load. Refresh this page to try again.';
});
