import {
  App,
  Stack,
  CfnParameter,
  CfnOutput,
  Duration,
  RemovalPolicy,
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
} from 'aws-cdk-lib';
const app = new App();
const stack = new Stack(app, 'HarborWeb');
const apiHost = new CfnParameter(stack, 'ApiHostname', {
  type: 'String',
  description: 'Existing harbor0 API Gateway hostname, without a scheme',
  allowedPattern: '[a-z0-9]+\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com',
}).valueAsString;
const bucket = new s3.Bucket(stack, 'WebAssets', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  versioned: true,
  removalPolicy: RemovalPolicy.RETAIN,
});
const headers = new cloudfront.ResponseHeadersPolicy(stack, 'WebHeaders', {
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
      contentSecurityPolicy: `default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.r2.cloudflarestorage.com; media-src 'self' https://*.r2.cloudflarestorage.com; connect-src 'self' https://*.r2.cloudflarestorage.com wss://*.execute-api.${stack.region}.amazonaws.com; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`,
      override: true,
    },
  },
});
const staticCache = new cloudfront.CachePolicy(stack, 'StaticCache', {
  minTtl: Duration.seconds(0),
  defaultTtl: Duration.seconds(60),
  maxTtl: Duration.days(365),
  enableAcceptEncodingBrotli: true,
  enableAcceptEncodingGzip: true,
  cookieBehavior: cloudfront.CacheCookieBehavior.none(),
  headerBehavior: cloudfront.CacheHeaderBehavior.none(),
  queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
});
// Next's static export writes /settings as settings.html. Resolve clean URLs at
// the edge while leaving API requests, assets and navigation payloads untouched.
const pageRoutes = new cloudfront.Function(stack, 'PageRoutes', {
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
const distribution = new cloudfront.Distribution(stack, 'Distribution', {
  defaultRootObject: 'index.html',
  errorResponses: [403, 404, 500, 502, 503, 504].map((httpStatus) => ({
    httpStatus,
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
  additionalBehaviors: {
    '/api/*': {
      origin: new origins.HttpOrigin(apiHost, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: headers,
      compress: true,
    },
  },
});
new CfnOutput(stack, 'WebUrl', { value: `https://${distribution.distributionDomainName}` });
new CfnOutput(stack, 'DistributionId', { value: distribution.distributionId });
new CfnOutput(stack, 'WebBucketName', { value: bucket.bucketName });
