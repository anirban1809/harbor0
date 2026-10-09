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
    aws_certificatemanager as acm,
    Tags,
} from 'aws-cdk-lib';
import { harborEnv } from './environment';
// The management console is a separate static export on its own distribution. Its `/api/*`
// goes to the console API (its own Lambda), never to the customer API.
const app = new App();
const stack = new Stack(app, harborEnv.stacks.admin);
if (!harborEnv.production) Tags.of(stack).add('Environment', harborEnv.name);
const apiHost = new CfnParameter(stack, 'AdminApiHostname', {
    type: 'String',
    description: 'The console API Gateway hostname (HarborStorage AdminApiUrl), without a scheme',
    allowedPattern: '[a-z0-9]+\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com',
}).valueAsString;
const bucket = new s3.Bucket(stack, 'AdminAssets', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    versioned: true,
    removalPolicy: RemovalPolicy.RETAIN,
});
const headers = new cloudfront.ResponseHeadersPolicy(stack, 'AdminHeaders', {
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
    customHeadersBehavior: {
        customHeaders: [{ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true }],
    },
});
const staticCache = new cloudfront.CachePolicy(stack, 'AdminCache', {
    minTtl: Duration.seconds(0),
    defaultTtl: Duration.seconds(60),
    maxTtl: Duration.days(365),
    enableAcceptEncodingBrotli: true,
    enableAcceptEncodingGzip: true,
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    headerBehavior: cloudfront.CacheHeaderBehavior.none(),
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
});
// Optional network allowlist: ADMIN_ALLOWED_IPS="203.0.113.7,198.51.100.0" limits the whole
// console (pages and API) to those addresses. Staff sign-in applies either way.
const allowed = (process.env.ADMIN_ALLOWED_IPS ?? '')
    .split(',')
    .map((ip) => ip.trim())
    .filter((ip) => /^[0-9a-f.:]+$/i.test(ip));
const allowlist = allowed.length
    ? `if (${JSON.stringify(allowed)}.indexOf(event.viewer.ip) === -1)
      return { statusCode: 403, statusDescription: 'Forbidden' };`
    : '';
const pageRoutes = new cloudfront.Function(stack, 'AdminRoutes', {
    code: cloudfront.FunctionCode.fromInline(`function handler(event) {
    var request = event.request;
    ${allowlist}
    var uri = request.uri;
    if (uri === '/') request.uri = '/index.html';
    else if (uri.indexOf('/_next/') !== 0 && uri.split('/').pop().indexOf('.') === -1) {
      request.uri = uri.replace(/\\/$/, '') + '.html';
    }
    return request;
  }`),
});
const apiGate = allowed.length
    ? new cloudfront.Function(stack, 'AdminApiGate', {
        code: cloudfront.FunctionCode.fromInline(`function handler(event) {
    ${allowlist}
    return event.request;
  }`),
    })
    : undefined;
const certArn = process.env.ADMIN_CERT_ARN;
const domainName = process.env.ADMIN_DOMAIN;
const distribution = new cloudfront.Distribution(stack, 'AdminDistribution', {
    ...(certArn && domainName
        ? {
            domainNames: [domainName],
            certificate: acm.Certificate.fromCertificateArn(stack, 'AdminCert', certArn),
        }
        : {}),
    defaultRootObject: 'index.html',
    // Error pages apply to every behaviour, so they would replace the console API's JSON errors
    // (403 FORBIDDEN, 404 USER_NOT_FOUND) with HTML. Only stop errors being cached.
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
            ...(apiGate
                ? {
                    functionAssociations: [
                        { function: apiGate, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
                    ],
                }
                : {}),
        },
    },
});
new CfnOutput(stack, 'AdminUrl', {
    value:
        certArn && domainName
            ? `https://${domainName}`
            : `https://${distribution.distributionDomainName}`,
});
new CfnOutput(stack, 'AdminDistributionId', { value: distribution.distributionId });
new CfnOutput(stack, 'AdminBucketName', { value: bucket.bucketName });
