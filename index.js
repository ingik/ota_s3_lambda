import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from '@aws-sdk/client-cloudfront';
import 'dotenv/config';

const s3Client = new S3Client({ region: process.env.BUCKET_REGION });
const cloudfrontClient = new CloudFrontClient({
  region: process.env.BUCKET_REGION,
});
const bucketName = process.env.BUCKET_NAME; // S3 버킷 이름

export const handler = async (event) => {
  const objectKey = event.Records[0].s3.object.key; // 업로드된 파일의 키

  // 특정 파일에 대해서만 처리
  if (
    !objectKey.startsWith('bundle/') ||
    (!objectKey.endsWith('main.jsbundle') &&
      !objectKey.endsWith('ootd_codepush_metadata.json'))
  ) {
    console.log('처리할 필요 없는 파일입니다.');
    return; // 함수 종료
  }

  // 플랫폼, 환경, 앱 버전 정보 추출
  const pathParts = objectKey.split('/');
  const platform = pathParts[1];
  const environment = pathParts[2];
  const appVersion = pathParts[3];
  const codepushVersion = pathParts[4];

  if (!platform || !environment || !appVersion) {
    console.error('필수 정보가 누락: ', { platform, environment, appVersion });
    return; // 함수 종료
  }

  try {
    await updateMetaData(platform, environment, appVersion, objectKey);
    const targetBucketObject = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `bundle/${platform}/${environment}/${appVersion}/`,
        Delimiter: '/',
      })
    );

    let patchVersionList = [];

    if (targetBucketObject.CommonPrefixes) {
      patchVersionList = targetBucketObject.CommonPrefixes.map((folder) =>
        folder.Prefix.split('/').filter(Boolean).pop()
      );

      console.log('✅ 패치 리스트 확인 ###########################');
    } else {
      console.log('✅ 패치 리스트 없음 ############################');
      return;
    }

    console.log('patchVersionList >>', patchVersionList);

    const previousVersion =
      patchVersionList.length > 1
        ? patchVersionList[patchVersionList.length - 2]
        : '0.0.1';

    // 이전 버전의 main.jsbundle 가져오기
    const previousBundleKey = `bundle/${platform}/${environment}/${appVersion}/${previousVersion}/main.jsbundle`;

    console.log('previousBundleKey >>', previousBundleKey);

    const previousBundleData = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: previousBundleKey,
      })
    );

    console.log('previousBundleData >>', previousBundleData);

    const previousBundleContents = await streamToString(
      previousBundleData.Body
    );

    console.log('previousBundleContents >>', previousBundleContents);

    // 새로운 main.jsbundle 가져오기
    const newBundleKey = objectKey;
    const newBundleData = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: newBundleKey,
      })
    );

    console.log('newBundleData >>', newBundleData);

    const newBundleContents = await streamToString(newBundleData.Body);

    console.log('newBundleContents >>', newBundleContents);

    // 패치 번들 생성
    const patchBundle = generatePatchBundle(
      previousBundleContents,
      newBundleContents
    );

    console.log('patchBundle >>', patchBundle);

    if (!patchBundle) {
      console.log('✅ 변경 사항 없음, 패치 파일 생성 안함.');
      return;
    }

    console.log('패치 번들 생성 완료', patchBundle);

    // 패치된 번들 S3에 업로드
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: `bundle/${platform}/${environment}/${appVersion}/${codepushVersion}/patch.jsbundle`,
        Body: patchBundle,
        ContentType: 'application/json',
      })
    );

    console.log('패치된 번들 저장 완료');

    // CloudFront 무효화
    await invalidateCache(platform, environment, appVersion);
  } catch (error) {
    console.error('패치 파일 생성 중 오류 발생:', error);
  }
};

// 스트림을 문자열로 변환
const streamToString = (stream) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => {
      try {
        chunks.push(Buffer.from(chunk));
      } catch (error) {
        console.error('스트림 데이터 처리 중 오류:', error);
        reject(error);
      }
    });
    stream.on('error', (error) => {
      console.error('스트림 오류 발생:', error);
      reject(error);
    });
    stream.on('end', () => {
      try {
        const result = Buffer.concat(chunks).toString('utf8');
        console.log('스트림 처리 완료, 데이터 크기:', result.length);
        resolve(result);
      } catch (error) {
        console.error('스트림 데이터 변환 중 오류:', error);
        reject(error);
      }
    });
  });
};

// CloudFront 무효화
const invalidateCache = async (platform, environment, appVersion) => {
  const params = {
    DistributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID, // CloudFront 배포 ID
    InvalidationBatch: {
      CallerReference: `${Date.now()}`, // 고유한 호출 참조
      Paths: {
        Quantity: 2, // 무효화할 경로 수
        Items: [
          `/bundle/${platform}/${environment}/${appVersion}/recentMetaData.json`, // 메타데이터 파일 무효화
          `/bundle/${platform}/${environment}/${appVersion}/patch.jsbundle`, // 패치 파일 무효화
        ],
      },
    },
  };

  try {
    await cloudfrontClient.send(new CreateInvalidationCommand(params));
    console.log('CloudFront 무효화 요청 완료');
  } catch (error) {
    console.error('무효화 중 오류 발생:', error);
  }
};

// 버전 데이터 가져오기
const getVersionData = async (objectKey) => {
  const data = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
    })
  );

  const bodyContents = await streamToString(data.Body);
  return JSON.parse(bodyContents);
};

// codepush 버전 메타데이터 업데이트
const updateMetaData = async (platform, environment, appVersion, objectKey) => {
  let recentMetaData;
  const newVersionData = await getVersionData(objectKey);
  console.log('updateMetaData', platform, environment, appVersion);
  try {
    const currentMetaData = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: `bundle/${platform}/${environment}/${appVersion}/recentMetaData.json`,
      })
    );

    const bodyContents = await streamToString(currentMetaData.Body);
    recentMetaData = JSON.parse(bodyContents);

    const patchMetaData = {
      latestVersion: {
        appVersion: newVersionData.appVersion,
        version: newVersionData.version,
        deploymentDate: newVersionData.deploymentDate,
        hash: newVersionData.hash,
        isInUse: true,
        deploymentEnv: environment,
        platform: platform,
      },
      previousVersions: [
        recentMetaData.latestVersion,
        ...recentMetaData.previousVersions,
      ],
    };

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: `bundle/${platform}/${environment}/${appVersion}/recentMetaData.json`,
        Body: JSON.stringify(patchMetaData),
        ContentType: 'application/json',
      })
    );
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      // recentMetaData.json 파일이 존재하지 않을 경우 기본 메타데이터 생성
      recentMetaData = {
        latestVersion: {
          appVersion: newVersionData.appVersion,
          version: newVersionData.version,
          deploymentDate: newVersionData.deploymentDate,
          hash: newVersionData.hash,
          isInUse: true,
          deploymentEnv: environment,
          platform: platform,
        },
        previousVersions: [],
      };

      // S3에 recentMetaData.json 업로드
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: `bundle/${platform}/${environment}/${appVersion}/recentMetaData.json`,
          Body: JSON.stringify(recentMetaData),
          ContentType: 'application/json',
        })
      );

      console.log('recentMetaData.json 파일이 존재하지 않아 새로 생성합니다.');

      await invalidateCache(platform, environment, appVersion);
      return;
    } else {
      console.error('S3에서 메타데이터 생성 중 오류 발생:', error);
      throw error;
    }
  }
};

// 모듈 추출 함수 개선
function validateBundle(bundleContent) {
  if (!bundleContent || typeof bundleContent !== 'string') {
    throw new Error('번들 콘텐츠가 유효하지 않습니다');
  }

  // 기본적인 번들 구조 확인
  if (!bundleContent.includes('__d(') && !bundleContent.includes('__r(')) {
    throw new Error('유효한 Metro 번들 형식이 아닙니다');
  }

  console.log('번들 유효성 검사 통과');
  return true;
}

function analyzeBundleFormat(bundleContent) {
  console.log('번들 형식 분석 중...');

  // 샘플 추출 (처음 10KB)
  const sample = bundleContent.substring(0, 10000);

  // 번들 형식 특징 확인
  const features = {
    hasMetroHeader: sample.includes('__BUNDLE_START_TIME__'),
    hasModuleDefs: sample.includes('__d('),
    hasRequireCalls: sample.includes('__r('),
    hasHermesOptimization: sample.includes('hbc'),
    isMinified: !sample.includes('\n  ') && sample.includes(';var '),
    moduleDefFormat: null,
  };

  // 모듈 정의 형식 확인
  if (features.hasModuleDefs) {
    if (sample.includes('__d(function(')) {
      features.moduleDefFormat = 'function';
    } else if (sample.includes('__d((')) {
      features.moduleDefFormat = 'arrow';
    } else {
      features.moduleDefFormat = 'unknown';
    }
  }

  console.log('번들 형식 분석 결과:', features);

  return features;
}

// 번들 파싱 함수 수정
function parseBundle(bundleContent) {
  console.log('번들 파싱 시작, 번들 크기:', bundleContent.length);

  // 번들 형식 분석
  const bundleFormat = analyzeBundleFormat(bundleContent);

  // 번들 형식에 따라 적절한 파싱 전략 선택
  let parseStrategy;

  if (bundleFormat.moduleDefFormat === 'function') {
    parseStrategy = parseFunctionModules;
  } else if (bundleFormat.moduleDefFormat === 'arrow') {
    parseStrategy = parseArrowModules;
  } else {
    parseStrategy = parseGenericModules;
  }

  try {
    // 선택된 전략으로 모듈 파싱
    const modules = parseStrategy(bundleContent);

    // 모듈이 하나도 추출되지 않았다면 대체 전략 시도
    if (Object.keys(modules).length === 0) {
      console.log('선택된 전략으로 모듈을 찾지 못했습니다. 대체 전략 시도...');
      const modules = parseGenericModules(bundleContent);

      if (Object.keys(modules).length === 0) {
        throw new Error(
          '모듈을 추출할 수 없습니다. 번들 형식이 예상과 다릅니다.'
        );
      }
    }

    return modules;
  } catch (error) {
    console.error('번들 파싱 중 오류:', error);
    throw error;
  }
}

// 함수 표현식 모듈 파싱
function parseFunctionModules(bundleContent) {
  const modules = {};
  let moduleCount = 0;

  // 함수 표현식 모듈 패턴
  const pattern =
    /__d\(\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*,\s*(\d+)\s*,\s*\[\s*([\d,\s]*)\s*\]/g;
  let match;

  while ((match = pattern.exec(bundleContent)) !== null) {
    const moduleBody = match[1];
    const moduleId = match[2];
    const dependencies = match[3]
      ? match[3]
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id)
      : [];

    modules[moduleId] = {
      id: moduleId,
      code: match[0],
      body: moduleBody,
      dependencies,
    };

    moduleCount++;

    if (moduleCount % 1000 === 0) {
      console.log(`${moduleCount}개 모듈 파싱됨...`);
    }
  }

  console.log(`함수 표현식 모듈 파싱 완료: ${moduleCount}개 모듈`);
  return modules;
}

// 화살표 함수 모듈 파싱
function parseArrowModules(bundleContent) {
  const modules = {};
  let moduleCount = 0;

  // 화살표 함수 모듈 패턴
  const pattern =
    /__d\(\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*(\d+)\s*,\s*\[\s*([\d,\s]*)\s*\]/g;
  let match;

  while ((match = pattern.exec(bundleContent)) !== null) {
    const moduleBody = match[1];
    const moduleId = match[2];
    const dependencies = match[3]
      ? match[3]
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id)
      : [];

    modules[moduleId] = {
      id: moduleId,
      code: match[0],
      body: moduleBody,
      dependencies,
    };

    moduleCount++;
  }

  console.log(`화살표 함수 모듈 파싱 완료: ${moduleCount}개 모듈`);
  return modules;
}

// 일반적인 모듈 파싱 (여러 패턴 시도)
function parseGenericModules(bundleContent) {
  const modules = {};
  let moduleCount = 0;

  // 모듈 ID와 의존성만 추출하는 간단한 패턴
  const simplePattern = /__d\([^,]+,\s*(\d+)\s*,\s*\[\s*([\d,\s]*)\s*\]/g;
  let match;

  while ((match = simplePattern.exec(bundleContent)) !== null) {
    const moduleId = match[1];
    const dependencies = match[2]
      ? match[2]
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id)
      : [];

    // 모듈 코드 추출 (간소화)
    const moduleCode = match[0];

    modules[moduleId] = {
      id: moduleId,
      code: moduleCode,
      body: '/* 모듈 본문 */',
      dependencies,
    };

    moduleCount++;
  }

  console.log(`일반 모듈 파싱 완료: ${moduleCount}개 모듈`);
  return modules;
}

// 번들 비교 함수 개선
function compareBundles(oldBundleContent, newBundleContent) {
  console.log('번들 비교 시작');

  try {
    // 번들에서 모듈 추출
    const oldModules = parseBundle(oldBundleContent);
    const newModules = parseBundle(newBundleContent);

    // 모듈 ID 집합 생성
    const oldModuleIds = new Set(Object.keys(oldModules));
    const newModuleIds = new Set(Object.keys(newModules));

    console.log(
      `이전 번들: ${oldModuleIds.size}개 모듈, 새 번들: ${newModuleIds.size}개 모듈`
    );

    // 추가된 모듈 찾기
    const added = [...newModuleIds].filter((id) => !oldModuleIds.has(id));

    // 삭제된 모듈 찾기
    const removed = [...oldModuleIds].filter((id) => !newModuleIds.has(id));

    // 수정된 모듈 찾기
    const modified = [...oldModuleIds].filter((id) => {
      if (newModuleIds.has(id)) {
        // 모듈 내용 비교
        return oldModules[id].body !== newModules[id].body;
      }
      return false;
    });

    console.log(
      `비교 결과: 추가=${added.length}, 수정=${modified.length}, 삭제=${removed.length}`
    );

    // 안전 검사: 모든 모듈이 삭제되고 새 모듈이 없는 경우
    if (removed.length > 0 && added.length === 0 && modified.length === 0) {
      if (removed.length === oldModuleIds.size) {
        console.error('모든 모듈이 삭제되는 패치는 생성할 수 없습니다');
        throw new Error('모든 모듈이 삭제되는 패치는 생성할 수 없습니다');
      }
    }

    return { added, modified, removed };
  } catch (error) {
    console.error('번들 비교 중 오류:', error);
    throw error;
  }
}

// 패치 번들 생성 함수 개선
function generatePatchBundle(oldBundleContent, newBundleContent) {
  console.log('패치 번들 생성 시작');

  try {
    // 입력 검증
    if (!oldBundleContent || !newBundleContent) {
      throw new Error('번들 콘텐츠가 비어 있습니다');
    }

    // 문자열로 변환
    const oldBundle =
      typeof oldBundleContent === 'string'
        ? oldBundleContent
        : oldBundleContent.toString('utf8');
    const newBundle =
      typeof newBundleContent === 'string'
        ? newBundleContent
        : newBundleContent.toString('utf8');

    console.log(
      '번들 길이 - 이전:',
      oldBundle.length,
      '새로운:',
      newBundle.length
    );

    // 번들 비교
    const diffResult = compareBundles(oldBundle, newBundle);

    // 변경 사항이 없으면 null 반환
    if (
      diffResult.added.length === 0 &&
      diffResult.modified.length === 0 &&
      diffResult.removed.length === 0
    ) {
      console.log('변경 사항이 없습니다');
      return null;
    }

    // 새 번들에서 모듈 파싱
    const newModules = parseBundle(newBundle);

    // 패치에 포함될 모듈 수집
    const patchModules = {};

    // 변경된 모듈 추가
    diffResult.modified.forEach((moduleId) => {
      if (newModules[moduleId]) {
        patchModules[moduleId] = newModules[moduleId];
      }
    });

    // 추가된 모듈 추가
    diffResult.added.forEach((moduleId) => {
      if (newModules[moduleId]) {
        patchModules[moduleId] = newModules[moduleId];
      }
    });

    // 의존성 분석 및 추가
    const dependencyModules = collectDependencies(
      patchModules,
      newModules,
      diffResult.removed
    );
    Object.assign(patchModules, dependencyModules);

    // 헤더와 푸터 추출
    const header = extractHeader(newBundle);
    const footer = extractFooter(newBundle);

    console.log(`헤더 크기: ${header.length}, 푸터 크기: ${footer.length}`);

    // 패치 메타데이터 생성
    const patchMetadata = {
      type: 'module-patch',
      version: Date.now().toString(),
      added: diffResult.added,
      modified: diffResult.modified,
      removed: diffResult.removed,
      moduleCount: Object.keys(patchModules).length,
    };

    // 패치 번들 생성 (JSON 형식)
    const patchBundle = {
      metadata: patchMetadata,
      modules: patchModules,
      header: header,
      footer: footer,
    };

    console.log('패치 번들 생성 완료');
    return JSON.stringify(patchBundle);
  } catch (error) {
    console.error('패치 번들 생성 중 오류:', error);
    throw error;
  }
}

// 번들 헤더 추출 함수 개선
function extractHeader(bundleContent) {
  // 첫 번째 __d 함수 호출 이전의 모든 내용을 헤더로 간주
  const firstModuleIndex = bundleContent.indexOf('__d(');
  if (firstModuleIndex === -1) {
    return bundleContent;
  }
  return bundleContent.substring(0, firstModuleIndex);
}

// 번들 푸터 추출 함수 개선
function extractFooter(bundleContent) {
  // 마지막 __d 함수 호출 이후의 모든 내용을 푸터로 간주
  const lastModuleRegex =
    /__d\(\s*function\s*\([^)]*\)\s*\{[\s\S]*?\}\s*,\s*\d+\s*,\s*\[\s*[\d,\s]*\s*\]\s*(?:,\s*"[^"]*")?\s*\)/g;
  let lastMatch;
  let match;

  while ((match = lastModuleRegex.exec(bundleContent)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return '';
  }

  const lastModuleEndIndex = lastMatch.index + lastMatch[0].length;
  return bundleContent.substring(lastModuleEndIndex);
}

// 의존성 모듈 수집 함수 개선
function collectDependencies(modules, allModules, removedModules) {
  console.log('의존성 모듈 수집 시작');

  const dependencies = {};
  const processedIds = new Set([...Object.keys(modules), ...removedModules]);
  const removedSet = new Set(removedModules);

  function processDependencies(moduleIds) {
    const newDependencies = [];

    moduleIds.forEach((id) => {
      if (!allModules[id]) {
        console.warn(`모듈 ID ${id}를 찾을 수 없습니다`);
        return;
      }

      allModules[id].dependencies.forEach((depId) => {
        if (processedIds.has(depId)) return;
        if (removedSet.has(depId)) return;

        if (allModules[depId]) {
          dependencies[depId] = allModules[depId];
          processedIds.add(depId);
          newDependencies.push(depId);
        } else {
          console.warn(`의존성 모듈 ID ${depId}를 찾을 수 없습니다`);
        }
      });
    });

    if (newDependencies.length > 0) {
      processDependencies(newDependencies);
    }
  }

  processDependencies(Object.keys(modules));
  console.log(`의존성 모듈 ${Object.keys(dependencies).length}개 수집됨`);

  return dependencies;
}
