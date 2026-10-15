import {
  App,
  Stack,
  CfnParameter,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Tags,
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
} from 'aws-cdk-lib';
import { harborEnv } from './environment';
// Public link pages (apps/share) on their own domain, harbor0content.online. Anything people
// share is downloaded from storage, but the page that offers it lives here, so a flagged link
// can only ever get this domain flagged, never harbor0.com or the app. The API is reached at
// /api/v1/public/* only; no other route, and no cookies, pass through this distribution.
const app = new App();
const stack = new Stack(app, harborEnv.stacks.share);
if (!harborEnv.production) Tags.of(stack).add('Environment', harborEnv.name);
const apiHost = new CfnParameter(stack, 'ApiHostname', {
  type: 'String',
  description: 'Existing harbor0 API Gateway hostname, without a scheme',
  allowedPattern: '[a-z0-9]+\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com',
}).valueAsString;
// Sent to the API as X-Harbor-Edge; public link routes refuse requests without it.
const edgeSecret = new CfnParameter(stack, 'EdgeSecret', {
  type: 'String',
  noEcho: true,
  description: 'Value of the PublicLinkEdgeSecret secret in the storage stack',
}).valueAsString;
const bucket = new s3.Bucket(stack, 'ShareAssets', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  versioned: true,
  removalPolicy: harborEnv.production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
});
const headers = new cloudfront.ResponseHeadersPolicy(stack, 'ShareHeaders', {
  securityHeadersBehavior: {
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
    referrerPolicy: {
      referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
      override: true,
    },
    strictTransportSecurity: {
      accessControlMaxAge: Duration.days(365),
      includeSubdomains: true,
      override: true,
    },
    contentSecurityPolicy: {
      contentSecurityPolicy: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`,
      override: true,
    },
  },
  // Links are private to whoever holds them; none of these pages belong in search results.
  customHeadersBehavior: {
    customHeaders: [{ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true }],
  },
});
const staticCache = new cloudfront.CachePolicy(stack, 'ShareCache', {
  minTtl: Duration.seconds(0),
  defaultTtl: Duration.seconds(60),
  maxTtl: Duration.days(365),
  enableAcceptEncodingBrotli: true,
  enableAcceptEncodingGzip: true,
  cookieBehavior: cloudfront.CacheCookieBehavior.none(),
  headerBehavior: cloudfront.CacheHeaderBehavior.none(),
  queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
});
// Next's static export writes /s as s.html. Resolve clean URLs at the edge, and send any other
// page path to the 404 page here: a distribution-wide error response would also replace the API's
// own JSON errors (a wrong password, an expired link) with that page.
const pageRoutes = new cloudfront.Function(stack, 'SharePageRoutes', {
  code: cloudfront.FunctionCode.fromInline(`function handler(event) {
    var request = event.request;
    var uri = request.uri.replace(/\\/$/, '') || '/';
    if (uri === '/') request.uri = '/index.html';
    else if (uri === '/s') request.uri = '/s.html';
    else if (uri.indexOf('/_next/') !== 0 && uri.split('/').pop().indexOf('.') === -1) {
      request.uri = '/404.html';
    }
    return request;
  }`),
});
// The API serves /v1/public/*; the page calls it as /api/v1/public/* on this origin.
const apiRoutes = new cloudfront.Function(stack, 'ShareApiRoutes', {
  code: cloudfront.FunctionCode.fromInline(`function handler(event) {
    var request = event.request;
    request.uri = request.uri.replace(/^\\/api/, '');
    return request;
  }`),
});
// Only what the public routes read: the visitor's address for rate limits, the body type and
// a link password's pass. No cookies, no Authorization.
const apiRequests = new cloudfront.OriginRequestPolicy(stack, 'ShareApiRequests', {
  headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
    'CloudFront-Viewer-Address',
    'Content-Type',
    'X-Harbor-Link-Pass',
  ),
  queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
  cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
});
// Served at harbor0content.online once its us-east-1 ACM certificate (SHARE_CERT_ARN) is
// issued; until then on the default CloudFront hostname.
const certArn = process.env.SHARE_CERT_ARN;
const distribution = new cloudfront.Distribution(stack, 'ShareDistribution', {
  ...(certArn
    ? {
        domainNames: [harborEnv.shareDomain],
        certificate: acm.Certificate.fromCertificateArn(stack, 'ShareCert', certArn),
      }
    : {}),
  defaultRootObject: 'index.html',
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
    cachePolicy: staticCache,
    responseHeadersPolicy: headers,
    functionAssociations: [
      { function: pageRoutes, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
    ],
    compress: true,
  },
  additionalBehaviors: {
    '/api/v1/public/*': {
      origin: new origins.HttpOrigin(apiHost, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        customHeaders: { 'X-Harbor-Edge': edgeSecret },
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: apiRequests,
      responseHeadersPolicy: headers,
      functionAssociations: [
        { function: apiRoutes, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
      ],
      compress: true,
    },
  },
});
new CfnOutput(stack, 'ShareUrl', {
  value: certArn
    ? `https://${harborEnv.shareDomain}`
    : `https://${distribution.distributionDomainName}`,
});
new CfnOutput(stack, 'ShareDistributionDomain', { value: distribution.distributionDomainName });
new CfnOutput(stack, 'ShareDistributionId', { value: distribution.distributionId });
new CfnOutput(stack, 'ShareBucketName', { value: bucket.bucketName });
