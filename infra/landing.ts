import {
  App,
  Stack,
  CfnOutput,
  Duration,
  RemovalPolicy,
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
} from 'aws-cdk-lib';
// The marketing site is a separate static export with its own distribution, so
// it never shares paths or cache invalidations with the web app.
const app = new App();
const stack = new Stack(app, 'HarborLanding');
const bucket = new s3.Bucket(stack, 'LandingAssets', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  versioned: true,
  removalPolicy: RemovalPolicy.RETAIN,
});
const headers = new cloudfront.ResponseHeadersPolicy(stack, 'LandingHeaders', {
  securityHeadersBehavior: {
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
    referrerPolicy: {
      referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
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
});
const staticCache = new cloudfront.CachePolicy(stack, 'LandingCache', {
  minTtl: Duration.seconds(0),
  defaultTtl: Duration.seconds(60),
  maxTtl: Duration.days(365),
  enableAcceptEncodingBrotli: true,
  enableAcceptEncodingGzip: true,
  cookieBehavior: cloudfront.CacheCookieBehavior.none(),
  headerBehavior: cloudfront.CacheHeaderBehavior.none(),
  queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
});
// Next's static export writes /apps as apps.html. Resolve clean URLs at the edge.
const pageRoutes = new cloudfront.Function(stack, 'LandingRoutes', {
  code: cloudfront.FunctionCode.fromInline(`function handler(event) {
    var request = event.request;
    var uri = request.uri;
    if (uri === '/') request.uri = '/index.html';
    else if (uri.indexOf('/_next/') !== 0 && uri.split('/').pop().indexOf('.') === -1) {
      request.uri = uri.replace(/\\/$/, '') + '.html';
    }
    return request;
  }`),
});
// harbor0.com is served once its us-east-1 ACM certificate is issued; without
// LANDING_CERT_ARN the site stays on the default CloudFront hostname.
const certArn = process.env.LANDING_CERT_ARN;
const domain = certArn
  ? {
      domainNames: ['harbor0.com', 'www.harbor0.com'],
      certificate: acm.Certificate.fromCertificateArn(stack, 'LandingCert', certArn),
    }
  : {};
const distribution = new cloudfront.Distribution(stack, 'LandingDistribution', {
  ...domain,
  defaultRootObject: 'index.html',
  errorResponses: [403, 404].map((httpStatus) => ({
    httpStatus,
    responseHttpStatus: 404,
    responsePagePath: '/404.html',
    ttl: Duration.seconds(0),
  })),
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
});
new CfnOutput(stack, 'LandingUrl', { value: `https://${distribution.distributionDomainName}` });
new CfnOutput(stack, 'LandingDistributionId', { value: distribution.distributionId });
new CfnOutput(stack, 'LandingBucketName', { value: bucket.bucketName });
