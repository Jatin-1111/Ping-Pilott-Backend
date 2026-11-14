pipeline {
    agent any
    
    options {
        skipDefaultCheckout()
    }
    
    stages {
        stage('Checkout') {
            steps {
                checkout([
                    $class: 'GitSCM',
                    branches: [[name: '*/main']],
                    extensions: [[$class: 'WipeWorkspace']],
                    userRemoteConfigs: [[
                        url: 'https://github.com/Jatin-1111/Ping-Pilott-Backend.git',
                        credentialsId: 'github-credentials'
                    ]]
                ])
            }
        }
        
        stage('Install Dependencies') {
            agent {
                docker {
                    // Same Node as the Dockerfile (18 reached end of life in April 2025; the image ran 20)
                    image 'node:24-alpine'
                    reuseNode true
                }
            }
            steps {
                sh 'npm ci'
            }
        }

        // The tests need no database or Redis. A failing test stops the pipeline before an image is built or pushed.
        stage('Test') {
            agent {
                docker {
                    image 'node:24-alpine'
                    reuseNode true
                }
            }
            steps {
                sh 'npm test'
            }
        }

        // Known-vulnerable production dependencies. Marks the build unstable instead of failing it: a new advisory in
        // a package nobody touched should be seen, not block an unrelated fix.
        stage('Dependency audit') {
            agent {
                docker {
                    image 'node:24-alpine'
                    reuseNode true
                }
            }
            steps {
                catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE') {
                    sh 'npm audit --omit=dev --audit-level=high'
                }
            }
        }

        stage('Build Docker Image') {
            steps {
                sh 'docker build -t ping-pilot:${BUILD_NUMBER} .'
            }
        }
        
        stage('Build & Push to Docker Hub') {
            steps {
                withCredentials([usernamePassword(credentialsId: 'dockerhub-creds', usernameVariable: 'DH_USER', passwordVariable: 'DH_PASS')]) {
                    sh '''
                    echo "$DH_PASS" | docker login -u "$DH_USER" --password-stdin
                    docker tag ping-pilot:${BUILD_NUMBER} $DH_USER/ping-pilot:${BUILD_NUMBER}
                    docker tag ping-pilot:${BUILD_NUMBER} $DH_USER/ping-pilot:latest
                    docker push $DH_USER/ping-pilot:${BUILD_NUMBER}
                    docker push $DH_USER/ping-pilot:latest
                    '''
                }
            }
        }
    }
    
    post {
        success {
            echo '✅ Build & Push Successful!'
        }
        failure {
            echo '❌ Build Failed!'
        }
    }
}